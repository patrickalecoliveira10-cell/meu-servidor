const bybitService = require('./bybit');
const db = require('../database/connection');
const config = require('../config');
// Caminho absoluto baseado na raiz para evitar erro no Render
const logger = require('../../../ai-brain/src/logs/logger');
const axios = require('axios');

const executorService = {
  isRunning: false,
  isPaused: false,
  emergencyMode: false,
  monitoringInterval: null,
  lastReasons: {}, // Armazena os motivos das decisões por moeda
  lastProcessedSignals: {}, // Trava de memória para evitar spam
  isProcessingEntry: false, // Bloqueio atômico para evitar múltiplas entradas simultâneas
  brainInstance: null,

  setBrain(brain) {
    this.brainInstance = brain;
    logger.info('[EXECUTOR] Brain instance linked for direct communication');
  },

  // Helper para calcular quantidade com precisão da Bybit
  async calculateQuantity(symbol, usdtAmount, currentPrice) {
    try {
      let qty = (usdtAmount / currentPrice);
      const instrument = await bybitService.getInstrumentInfo(symbol);

      if (instrument && instrument.lotSizeFilter) {
        const qtyStep = parseFloat(instrument.lotSizeFilter.qtyStep);
        const precision = Math.log10(1 / qtyStep);
        if (precision >= 0) {
          qty = Math.floor(qty / qtyStep) * qtyStep;
          qty = qty.toFixed(precision);
        } else {
          qty = Math.floor(qty);
        }
      } else {
        if (currentPrice > 100) qty = qty.toFixed(2);
        else if (currentPrice > 10) qty = qty.toFixed(1);
        else qty = qty.toFixed(0);
      }
      return parseFloat(qty).toString();
    } catch (e) {
      return (usdtAmount / currentPrice).toFixed(2);
    }
  },

  async initialize() {
    try {
      logger.info('Initializing Executor Service Core...');
      
      // Teste de conexão com Bybit
      const bybitConnected = await bybitService.testConnection();
      if (!bybitConnected) {
        logger.warn('Bybit connection failed during init, will retry in loop');
      }

      await this.syncPositions();
      logger.info('Executor Service initialized successfully');
      return true;
    } catch (error) {
      logger.error('Failed to initialize Executor Service:', error);
      throw error;
    }
  },

  async syncPositions() {
    try {
      logger.info('Syncing positions with exchange...');
      const positions = await bybitService.getPosition();
      logger.info(`Found ${positions ? positions.length : 0} positions on Bybit`);
    } catch (error) {
      logger.error('Error syncing positions:', error.message);
    }
  },

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    logger.info('Starting Executor monitoring loop...');

    // Execução imediata
    this.monitorAndExecute();

    // Intervalo de polling reduzido para 10s no modo unificado para análise em tempo real
    const isUnified = process.env.UNIFIED_MODE === 'true';
    const interval = isUnified ? 10000 : ((config.aiBrain && config.aiBrain.pollInterval) || 30000);

    this.monitoringInterval = setInterval(() => {
      if (!this.isPaused && !this.emergencyMode) {
        this.monitorAndExecute();
      }
    }, interval);
  },

  async monitorAndExecute() {
    const cycleId = Math.random().toString(36).substring(5);
    try {
      // 1. Verificar se há posição aberta na Bybit
      const allPositions = await bybitService.getPosition() || [];
      const activePositions = allPositions.filter(p => parseFloat(p.size || 0) > 0);

      logger.info(`[EXE-V2.1-SNIPER] Ciclo ${cycleId} Iniciado. Posições Ativas: ${activePositions.length}. Trava Entry: ${this.isProcessingEntry}`);

      if (activePositions.length > 0) {
        const pos = activePositions[0];
        await this.handleDynamicManagement(pos);
        return;
      }

      if (this.isProcessingEntry) {
        logger.warn(`[EXE-V2.1-SNIPER] Bloqueado: Já existe uma entrada em processamento.`);
        return;
      }

      await this.checkAIRecommendations(cycleId);
    } catch (error) {
      logger.error(`[EXE-V2.1-SNIPER] Erro no Ciclo ${cycleId}:`, error.message);
    }
  },

  async handleDynamicManagement(position) {
    try {
      const symbol = position.symbol;

      // Obter dados recentes do scanner para análise
      const isUnified = process.env.UNIFIED_MODE === 'true';
      const port = process.env.PORT || 10000;
      const baseUrl = isUnified ? `http://localhost:${port}` : 'https://trickappserv2.onrender.com';

      const scannerResp = await axios.get(`${baseUrl}/api/scanner/status`, { timeout: 3000 });
      const snapshots = scannerResp.data?.data || scannerResp.data || [];
      const snapshot = snapshots.find(s => s.coin_id === symbol || s.symbol === symbol);

      if (!snapshot || !this.brainInstance) return;

      // Buscar info adicional no banco sobre essa operação
      const opInfo = await db.query(
        "SELECT * FROM trading_ai.operations WHERE symbol = $1 AND status = 'OPEN' LIMIT 1",
        [symbol]
      );

      if (opInfo.rows.length === 0) return;
      const dbPos = opInfo.rows[0];

      // Inteligência analisa o que fazer com a posição aberta
      const decision = this.brainInstance.intelligence.analyzeLivePosition(snapshot, {
        ...dbPos,
        entry_price: parseFloat(dbPos.entry_price) / 10000000000
      });

      // ATUALIZA MOTIVO: Garante que o App Android mostre a análise em tempo real, mesmo em 'hold'
      if (decision.reason) {
        this.lastReasons[symbol] = decision.reason;
      }

      if (decision.action !== 'hold') {
        logger.info(`[DYNAMIC] Action for ${symbol}: ${decision.action} - ${decision.reason}`);

        // Executar a ação na exchange via updatePositionManagement
        await this.updatePositionManagement({
            coin_id: symbol,
            decision: decision.action,
            params: decision.params,
            reason: decision.reason
        });

        // Atualizar banco de dados com a nova análise e status usando o helper Centralizado
        const updateData = {
            reason: decision.reason,
            partial_exit_done: decision.action === 'partial_exit' ? true : dbPos.partial_exit_done,
            partial_entry_count: decision.action === 'partial_entry' ? (dbPos.partial_entry_count || 0) + 1 : dbPos.partial_entry_count,
            stop_loss: decision.params?.new_stop || null,
            trailing_stop: decision.params?.trailing_stop || null
        };

        const queries = require('../../../ai-brain/src/database/queries');
        await queries.updateOperationDynamic(symbol, updateData);
      }
    } catch (err) {
      logger.error(`Error in dynamic management for ${position.symbol}:`, err.message);
    }
  },

  async checkAIRecommendations(cycleId = 'default') {
    try {
      let signals;

      // MODO UNIFICADO: Acesso direto à memória para tempo real
      if (this.brainInstance) {
        signals = this.brainInstance.getRecommendations();
      } else {
        // MODO SEPARADO: Fallback para API HTTP
        const isUnified = process.env.UNIFIED_MODE === 'true';
        const port = process.env.PORT || 10000;
        const baseUrl = isUnified ? `http://localhost:${port}` : ((config.aiBrain && config.aiBrain.apiUrl) || 'https://trickappserv2.onrender.com');

        const response = await axios.get(`${baseUrl}/api/recommendations`, { timeout: 5000 });
        signals = (response.data && response.data.data) ? response.data.data : response.data;
      }

      if (signals && Array.isArray(signals)) {
        // 1. ATUALIZAR MOTIVOS
        for (const signal of signals) {
          const sym = (signal.coin_id || signal.symbol || '').toUpperCase();
          if (sym && signal.stayReason) {
            this.lastReasons[sym] = signal.stayReason;
          }
        }

        // 2. FILTRAR O MELHOR SINAL DE ENTRADA (Modo Sniper)
        if (!this.isProcessingEntry) {
          const entrySignals = signals
            .filter(s => (s.decision === 'enter' || s.decision === 'ENTRY') && (s.confidence >= 0.68))
            .sort((a, b) => (b.confidence || 0) - (a.confidence || 0));

          if (entrySignals.length > 0) {
            logger.info(`[EXECUTOR-${cycleId}] Sniper detectou ${entrySignals.length} oportunidades. Melhor: ${entrySignals[0].coin_id} (${entrySignals[0].confidence})`);
            await this.processRecommendation(entrySignals[0]);
          }
        } else {
            logger.warn(`[EXECUTOR-${cycleId}] Ignorando recomendações: Entrada em processamento.`);
        }
      }
    } catch (error) {
      if (!this.brainInstance) logger.debug(`[EXECUTOR-${cycleId}] AI Brain heartbeat check failed`);
    }
  },

  async processRecommendation(decision) {
    if (this.isPaused || this.emergencyMode || this.isProcessingEntry) return { status: 'skipped', reason: 'busy_or_paused' };

    try {
      const symbol = (decision.coin_id || decision.symbol || '').toUpperCase();
      const side = (decision.side || 'Buy').toLowerCase() === 'buy' ? 'Buy' : 'Sell';

      if (!symbol) return { status: 'error', reason: 'invalid_symbol' };

      // SÓ PROCESSA SE FOR SINAL DE ENTRADA
      if (decision.decision !== 'ENTRY' && decision.decision !== 'enter') {
        return { status: 'ignored', reason: 'not_entry_signal' };
      }

      // 1. BUSCA POSIÇÕES REAIS NA BYBIT (Verificação final)
      const allPositions = await bybitService.getPosition() || [];
      const activePositions = allPositions.filter(p => parseFloat(p.size || 0) > 0);

      if (activePositions.length > 0) {
        return { status: 'skipped', reason: 'already_has_position' };
      }

      // 2. BLOQUEIO ATÔMICO
      this.isProcessingEntry = true;
      logger.info(`[EXE-V2.1-SNIPER] ATIVANDO TRAVA para ${symbol}.`);

      try {
        const now = Date.now();
        if (this.lastProcessedSignals[symbol] && (now - this.lastProcessedSignals[symbol] < 60000)) {
            logger.info(`[EXE-V2.1-SNIPER] Anti-spam ativo para ${symbol}.`);
            return { status: 'skipped', reason: 'recently_processed' };
        }

        logger.info(`[EXE-V2.1-SNIPER] EXECUÇÃO INICIADA: ${side} ${symbol} @ 85%+ confiança.`);
        this.lastProcessedSignals[symbol] = now;

        const balance = await bybitService.getWalletBalance();
        const currentPrice = await bybitService.getTickerPrice(symbol);

        if (currentPrice <= 0) {
          return { status: 'error', reason: 'could_not_get_price' };
        }

        // Calcula 30% da banca atual
        const thirtyPercent = balance * 0.3;
        // Regra: Mínimo 5.2 ou 30%
        let targetUsdtAmount = Math.max(5.2, thirtyPercent);

        // Proteção de saldo
        if (targetUsdtAmount > balance * 0.95) {
          targetUsdtAmount = balance * 0.95;
        }

        if (targetUsdtAmount < 5.2) {
            logger.warn(`[EXECUTOR] Saldo insuficiente para entrada inicial de 5.2 USDT`);
            return { status: 'skipped', reason: 'insufficient_balance' };
        }

        const qty = await this.calculateQuantity(symbol, targetUsdtAmount, currentPrice);

        logger.info(`[EXECUTOR] Banca: ${balance} USDT | Entrada Inicial: ${targetUsdtAmount} USDT (${qty} ${symbol})`);

        const order = await bybitService.placeOrder(
          symbol,
          side,
          'Market',
          qty
        );

        // Registrar a abertura da operação no DB
        try {
          const scaledPrice = BigInt(Math.round(currentPrice * 10000000000));
          await db.query(
            'INSERT INTO trading_ai.operations (symbol, side, entry_price, status, opened_at) VALUES ($1, $2, $3, $4, NOW())',
            [symbol, side, scaledPrice, 'OPEN']
          );
          logger.info(`[DB] Operação registrada para ${symbol} com preço escalado ${scaledPrice}`);
        } catch (dbErr) {
          logger.warn('Erro ao registrar no DB, mas ordem foi enviada:', dbErr.message);
        }

        return { status: 'success', orderId: order.orderId };
      } finally {
        this.isProcessingEntry = false;
      }

      return { status: 'ignored', reason: 'unknown_decision' };
    } catch (error) {
      this.isProcessingEntry = false;
      logger.error(`Failed to execute order for ${decision.coin_id}: ${error.message}`);
      throw error;
    }
  },

  async updatePositionManagement(signal) {
    try {
      const coin_id = (signal.coin_id || signal.symbol || '').toUpperCase();
      const { decision, params } = signal;

      if (!coin_id) throw new Error('Symbol/Coin_id is required for management');

      logger.info(`[MANAGEMENT] Signal received for ${coin_id}: ${decision}`);

      // Salva o motivo para o Android ler
      if (signal.reason) {
          this.lastReasons[coin_id] = signal.reason;
      }

      const allPositions = await bybitService.getPosition(coin_id);
      // Filtra posições realmente abertas (size > 0)
      const activePos = allPositions.find(p => p.symbol === coin_id && parseFloat(p.size || 0) > 0);

      if (!activePos) {
        logger.warn(`[EXECUTOR] Management signal ${decision} for ${coin_id} ignored: No active position found.`);
        return { status: 'ignored', reason: 'no_active_position' };
      }

      switch (decision) {
        case 'partial_entry':
          const balance = await bybitService.getWalletBalance();
          if (balance < 5.2) {
              logger.warn(`[EXECUTOR] Saldo insuficiente para entrada parcial (Mín 5.2, Atual ${balance})`);
              return { status: 'ignored', reason: 'insufficient_balance' };
          }

          const currentPrice = await bybitService.getTickerPrice(coin_id);
          // Adiciona 15% da banca ou 5.2 (o que for maior)
          let entryAmount = Math.max(5.2, balance * 0.15);

          if (entryAmount > balance * 0.9) entryAmount = balance * 0.9;

          if (entryAmount < 5.2) {
              return { status: 'ignored', reason: 'amount_below_min' };
          }

          const entryQty = await this.calculateQuantity(coin_id, entryAmount, currentPrice);

          logger.info(`[EXECUTOR] Executing partial entry for ${coin_id}: ${entryAmount} USDT (${entryQty} units)`);
          await bybitService.placeOrder(coin_id, activePos.side, 'Market', entryQty);
          break;

        case 'partial_exit':
          const exitQty = (parseFloat(activePos.size) * (params.percent || 0.5)).toString();
          const closeSide = activePos.side === 'Buy' ? 'Sell' : 'Buy';
          logger.info(`[EXECUTOR] Executing partial exit for ${coin_id}: ${exitQty} units`);
          await bybitService.placeOrder(coin_id, closeSide, 'Market', exitQty);
          break;

        case 'activate_trailing':
          logger.info(`[EXECUTOR] Activating Native Trailing Stop for ${coin_id}: Distance ${params.trailing_stop}`);
          await bybitService.setTradingStop(coin_id, null, null, params.trailing_stop);
          break;

        case 'move_stop':
          logger.info(`[EXECUTOR] Moving Stop Loss for ${coin_id} to ${params.new_stop}`);
          await bybitService.setTradingStop(coin_id, params.new_stop.toString());
          break;

        case 'close':
          const fullCloseSide = activePos.side === 'Buy' ? 'Sell' : 'Buy';
          let finalCloseQty = activePos.size;

          // AJUSTE DE PRECISÃO NO FECHAMENTO
          const instrumentClose = await bybitService.getInstrumentInfo(coin_id);
          if (instrumentClose && instrumentClose.lotSizeFilter) {
            const qtyStep = parseFloat(instrumentClose.lotSizeFilter.qtyStep);
            const precision = Math.log10(1 / qtyStep);
            if (precision >= 0) {
              finalCloseQty = (Math.floor(parseFloat(finalCloseQty) / qtyStep) * qtyStep).toFixed(precision);
            }
          }

          logger.info(`[EXECUTOR] Closing FULL position for ${coin_id} (${finalCloseQty} units) using ${fullCloseSide}`);

          await bybitService.placeOrder(
            coin_id,
            fullCloseSide,
            'Market',
            finalCloseQty.toString(),
            null, // price
            null, // SL
            null, // TP
            true  // reduceOnly OBRIGATÓRIO PARA FECHAR
          );

          // Limpa ordens pendentes e stops ao fechar manual
          await bybitService.cancelAllOrders(coin_id);

          try {
            const exitPrice = activePos.markPrice || activePos.avgPrice || 0;
            const scaledExitPrice = BigInt(Math.round(parseFloat(exitPrice) * 10000000000));

            await db.query(
              "UPDATE trading_ai.operations SET status = 'CLOSED', exit_price = $1, close_time = NOW() WHERE symbol = $2 AND status = 'OPEN'",
              [scaledExitPrice, coin_id]
            );
            logger.info(`[DB] Operação encerrada para ${coin_id} com preço ${scaledExitPrice}`);
          } catch (err) { logger.error('DB Update error (close):', err.message); }
          break;
      }

      return { status: 'success', decision };
    } catch (error) {
      logger.error('Management execution error:', error.message);
      throw error;
    }
  },

  getStatus() {
    return {
      isRunning: this.isRunning,
      isPaused: this.isPaused,
      emergencyMode: this.emergencyMode,
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString()
    };
  },

  async stop() {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }
    this.isRunning = false;
    logger.info('Executor Service stopped');
  }
};

module.exports = executorService;
