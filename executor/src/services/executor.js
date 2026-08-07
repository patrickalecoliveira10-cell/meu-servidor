const bybitService = require('./bybit');
const db = require('../database/connection');
const logger = require('../../../ai-brain/src/logs/logger');
const axios = require('axios');

const executorService = {
  isRunning: false,
  isPaused: false,
  isProcessingEntry: false,
  lastReasons: {},
  brainInstance: null,

  setBrain(brain) { this.brainInstance = brain; },

  normalizeSymbol(s) { return s.toUpperCase().replace(/[^A-Z0-9]/g, ''); },

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    const interval = process.env.UNIFIED_MODE === 'true' ? 10000 : 30000;
    setInterval(() => { if (!this.isPaused) this.monitorAndExecute(); }, interval);
    logger.info(`[EXECUTOR] Sniper Ativo 24h (${interval}ms)`);
  },

  async monitorAndExecute() {
    try {
      const allPositions = await bybitService.getPosition() || [];
      const activePositions = allPositions.filter(p => parseFloat(p.size || 0) > 0);

      if (activePositions.length > 0) {
        for (const pos of activePositions) {
          await this.handleDynamicManagement(pos);
        }
        return;
      }

      if (!this.isProcessingEntry) await this.checkAIRecommendations();
    } catch (e) { logger.error(`[EXECUTOR] Erro: ${e.message}`); }
  },

  async handleDynamicManagement(position) {
    const symbol = this.normalizeSymbol(position.symbol);
    const isUnified = process.env.UNIFIED_MODE === 'true';
    const baseUrl = isUnified ? `http://localhost:${process.env.PORT || 10000}` : 'https://trickappserv2.onrender.com';

    try {
      const scannerResp = await axios.get(`${baseUrl}/api/scanner/status`, { timeout: 3000 });
      const snapshot = (scannerResp.data?.data || []).find(s => this.normalizeSymbol(s.coin_id) === symbol);

      if (!snapshot || !this.brainInstance) return;

      const op = (await db.query("SELECT * FROM trading_ai.operations WHERE symbol = $1 AND status = 'OPEN'", [symbol])).rows[0];
      if (!op) return;

      const decision = this.brainInstance.intelligence.analyzeLivePosition(snapshot, {
        ...op, entry_price: parseFloat(op.entry_price) / 10000000000
      });

      this.lastReasons[symbol] = decision.reason;

      if (decision.action !== 'hold') {
        logger.info(`[DYNAMIC] ${symbol}: ${decision.reason}`);
        await this.updatePositionManagement({ coin_id: symbol, decision: decision.action, params: decision.params });

        const queries = require('../../../ai-brain/src/database/queries');
        await queries.updateOperationDynamic(symbol, {
            reason: decision.reason,
            partial_exit_done: decision.action === 'partial_exit' || op.partial_exit_done,
            partial_entry_count: decision.action === 'partial_entry' ? (op.partial_entry_count + 1) : op.partial_entry_count,
            stop_loss: decision.params?.new_stop,
            trailing_stop: decision.params?.trailing_stop
        });
      }
    } catch (err) { logger.error(`Dynamic Error ${symbol}: ${err.message}`); }
  },

  async checkAIRecommendations() {
    const signals = this.brainInstance ? this.brainInstance.getRecommendations() : [];
    const best = signals.filter(s => s.decision === 'ENTER' && s.confidence >= 0.60).sort((a,b) => b.confidence - a.confidence)[0];
    if (best) await this.processRecommendation(best);
  },

  async processRecommendation(decision) {
    const symbol = this.normalizeSymbol(decision.coin_id);
    this.isProcessingEntry = true;
    try {
      const balance = await bybitService.getWalletBalance();
      const price = await bybitService.getTickerPrice(symbol);
      let amount = Math.max(5.2, balance * 0.30);
      if (amount > balance * 0.90) amount = balance * 0.90;

      const qty = await this.calculateQuantity(symbol, amount, price);
      await bybitService.placeOrder(symbol, 'Buy', 'Market', qty);

      const scaledPrice = BigInt(Math.round(price * 10000000000));
      await db.query('INSERT INTO trading_ai.operations (symbol, side, entry_price, status, opened_at) VALUES ($1, $2, $3, $4, NOW())', [symbol, 'Buy', scaledPrice, 'OPEN']);
      logger.info(`[SNIPER] Entrada Realizada: ${symbol} @ ${price}`);
    } catch (e) { logger.error(`Entry Error: ${e.message}`); }
    finally { this.isProcessingEntry = false; }
  },

  async calculateQuantity(symbol, amount, price) {
    const inst = await bybitService.getInstrumentInfo(symbol);
    const step = inst?.lotSizeFilter?.qtyStep || '1';
    const prec = Math.max(0, Math.log10(1/parseFloat(step)));
    return (Math.floor((amount/price)/parseFloat(step))*parseFloat(step)).toFixed(prec);
  },

  async updatePositionManagement(signal) {
    const symbol = this.normalizeSymbol(signal.coin_id);
    const { decision, params } = signal;
    const pos = (await bybitService.getPosition(symbol)).find(p => parseFloat(p.size) > 0);
    if (!pos) return;

    try {
      if (decision === 'close') {
        await bybitService.placeOrder(symbol, 'Sell', 'Market', pos.size, null, null, null, true);
      } else if (decision === 'activate_trailing') {
        await bybitService.setTradingStop(symbol, null, null, params.trailing_stop.toString());
      } else if (decision === 'move_stop') {
        await bybitService.setTradingStop(symbol, params.new_stop.toString());
      } else if (decision === 'partial_entry') {
          const bal = await bybitService.getWalletBalance();
          if (bal >= 5.2) {
              const p = await bybitService.getTickerPrice(symbol);
              const q = await this.calculateQuantity(symbol, bal * 0.15, p);
              await bybitService.placeOrder(symbol, 'Buy', 'Market', q);
          }
      }
    } catch (e) { logger.error(`Mgmt Action Error: ${e.message}`); }
  },

  getStatus() {
    return {
      isRunning: this.isRunning,
      isPaused: this.isPaused,
      isProcessingEntry: this.isProcessingEntry
    };
  }
};

module.exports = executorService;
