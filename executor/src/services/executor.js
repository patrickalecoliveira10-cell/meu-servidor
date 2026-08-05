const bybitService = require('./bybit');
const db = require('../database/connection');
const config = require('../config');
const logger = require('../logger.js');
const axios = require('axios');

const executorService = {
  isRunning: false,
  isPaused: false,
  emergencyMode: false,
  monitoringInterval: null,

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

    // Intervalo de polling aumentado para economizar recursos (30 segundos)
    const interval = (config.aiBrain && config.aiBrain.pollInterval) || 30000;
    this.monitoringInterval = setInterval(() => {
      if (!this.isPaused && !this.emergencyMode) {
        this.monitorAndExecute();
      }
    }, interval);
  },

  async monitorAndExecute() {
    try {
      await this.checkAIRecommendations();
    } catch (error) {
      logger.error('Loop error:', error.message);
    }
  },

  async checkAIRecommendations() {
    try {
      // Se estiver rodando unificado, usa localhost para não gastar banda de internet
      const isUnified = process.env.UNIFIED_MODE === 'true';
      const port = process.env.PORT || 10000;
      const baseUrl = isUnified ? `http://localhost:${port}` : ((config.aiBrain && config.aiBrain.apiUrl) || 'https://trickappserv2.onrender.com');

      const response = await axios.get(`${baseUrl}/api/recommendations`, { timeout: 5000 });

      if (response.data && Array.isArray(response.data)) {
        for (const signal of response.data) {
          await this.processRecommendation(signal);
        }
      }
    } catch (error) {
      logger.debug('AI Brain heartbeat check failed');
    }
  },

  async processRecommendation(decision) {
    if (this.isPaused || this.emergencyMode) return { status: 'skipped', reason: 'paused' };

    try {
      const symbol = (decision.coin_id || decision.symbol || '').toUpperCase();
      const side = (decision.side || 'Buy').toLowerCase() === 'buy' ? 'Buy' : 'Sell';

      if (!symbol) {
        return { status: 'error', reason: 'invalid_symbol' };
      }

      // 1. BUSCA POSIÇÕES REAIS NA BYBIT
      const allPositions = await bybitService.getPosition() || [];

      // Filtrar apenas posições com tamanho real (Bybit V5 retorna entradas vazias para muitos símbolos)
      const activePositions = allPositions.filter(p => parseFloat(p.size || 0) > 0);

      // 2. TRAVA DE SEGURANÇA: Só um trade por vez
      if (activePositions.length > 0) {
        logger.info(`[BLOQUEIO] Tentativa de entrada em ${symbol} negada: Já existe um trade aberto em ${activePositions[0].symbol}.`);
        return {
          status: 'skipped',
          reason: 'already_has_open_position',
          active_pair: activePositions[0].symbol
        };
      }

      logger.info(`[EXECUTOR] Iniciando operação para ${symbol}...`);

      if (decision.decision === 'ENTRY' || decision.decision === 'enter') {
        // LÓGICA DE GESTÃO DE BANCA: Mínimo 5.2 USDT ou 30% da banca
        const balance = await bybitService.getWalletBalance();
        const currentPrice = await bybitService.getTickerPrice(symbol);

        if (currentPrice <= 0) {
          return { status: 'error', reason: 'could_not_get_price' };
        }

        // Calcula 30% da banca
        const thirtyPercent = balance * 0.3;
        // Usa o maior entre 5.2 e 30%
        let targetUsdtAmount = Math.max(5.2, thirtyPercent);

        // Proteção extra: não usar mais do que o saldo disponível (deixando margem)
        if (targetUsdtAmount > balance * 0.9) {
          targetUsdtAmount = balance * 0.9;
        }

        if (targetUsdtAmount < 5.2 && balance >= 5.2) {
            targetUsdtAmount = 5.2; // Garante o mínimo se houver saldo
        }

        // Converte valor em USDT para quantidade da moeda
        let qty = (targetUsdtAmount / currentPrice);

        // Ajuste de precisão baseado nas regras da exchange
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
          logger.info(`[EXECUTOR] Aplicando precisão para ${symbol}: Step=${qtyStep}, Qty final=${qty}`);
        } else {
          // Fallback heurístico
          if (currentPrice > 100) qty = qty.toFixed(2);
          else if (currentPrice > 10) qty = qty.toFixed(1);
          else if (currentPrice > 1) qty = qty.toFixed(1);
          else qty = Math.floor(qty);
        }

        qty = parseFloat(qty).toString();

        logger.info(`[EXECUTOR] Banca: ${balance} USDT | Alocando: ${targetUsdtAmount} USDT (${qty} ${symbol})`);

        const order = await bybitService.placeOrder(
          symbol,
          side,
          'Market',
          qty
        );

        // Registrar a abertura da operação no DB
        try {
          await db.query(
            'INSERT INTO trading_ai.operations (symbol, side, entry_price, status, opened_at) VALUES ($1, $2, $3, $4, NOW())',
            [symbol, side, currentPrice, 'OPEN']
          );
          logger.info(`[DB] Operação registrada para ${symbol}`);
        } catch (dbErr) {
          logger.warn('Erro ao registrar no DB, mas ordem foi enviada:', dbErr.message);
        }

        return { status: 'success', orderId: order.orderId };
      }

      return { status: 'ignored', reason: 'unknown_decision' };
    } catch (error) {
      logger.error(`Failed to execute order for ${decision.coin_id}: ${error.message}`);
      throw error;
    }
  },

  async updatePositionManagement(signal) {
    try {
      const { coin_id, decision, params } = signal;
      logger.info(`[MANAGEMENT] Signal received for ${coin_id}: ${decision}`);

      const positions = await bybitService.getPosition(coin_id);
      const activePos = positions.find(p => p.symbol === coin_id && parseFloat(p.size) > 0);

      if (!activePos) {
        logger.warn(`[EXECUTOR] Management signal ${decision} for ${coin_id} ignored: No active position.`);
        return { status: 'ignored', reason: 'no_active_position' };
      }

      switch (decision) {
        case 'partial_exit':
          const exitQty = (parseFloat(activePos.size) * params.percent).toString();
          const closeSide = activePos.side === 'Buy' ? 'Sell' : 'Buy';
          logger.info(`[EXECUTOR] Executing partial exit for ${coin_id}: ${params.percent * 100}%`);
          await bybitService.placeOrder(coin_id, closeSide, 'Market', exitQty);

          // Marcar parcial como feita no DB
          try {
            await db.query(
              'UPDATE trading_ai.operations SET p_exit_done = TRUE WHERE symbol = $1 AND status = $2',
              [coin_id, 'OPEN']
            );
          } catch (err) { logger.error('DB Update error (partial):', err.message); }
          break;

        case 'activate_trailing':
          logger.info(`[EXECUTOR] Activating Native Trailing Stop for ${coin_id}: Recoil ${params.trailing_stop}`);
          await bybitService.setTradingStop(coin_id, null, null, params.trailing_stop);

          // Marcar trailing como ativo no DB
          try {
            await db.query(
              'UPDATE trading_ai.operations SET ts_active = TRUE WHERE symbol = $1 AND status = $2',
              [coin_id, 'OPEN']
            );
          } catch (err) { logger.error('DB Update error (trailing):', err.message); }
          break;

        case 'move_stop':
          logger.info(`[EXECUTOR] Moving Stop Loss for ${coin_id} to ${params.new_stop}`);
          await bybitService.setTradingStop(coin_id, params.new_stop);
          break;

        case 'close':
          logger.info(`[EXECUTOR] Closing full position for ${coin_id}`);
          await bybitService.placeOrder(
            coin_id,
            activePos.side === 'Buy' ? 'Sell' : 'Buy',
            'Market',
            activePos.size
          );

          // Fechar no DB
          try {
            await db.query(
              'UPDATE trading_ai.operations SET status = $1, exit_price = $2, close_time = NOW() WHERE symbol = $3 AND status = $4',
              ['CLOSED', activePos.markPrice || 0, coin_id, 'OPEN']
            );
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
