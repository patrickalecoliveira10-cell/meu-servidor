const bybitService = require('./bybit');
const db = require('../database/connection');
const logger = require('../../../ai-brain/src/logs/logger');
const axios = require('axios');

const executorService = {
  isRunning: false,
  isProcessingEntry: false,
  lastReasons: {},
  brainInstance: null,

  setBrain(brain) { this.brainInstance = brain; },

  normalizeSymbol(s) { return s.toUpperCase().replace(/[^A-Z0-9]/g, ''); },

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    setInterval(() => { if (!this.isProcessingEntry) this.monitorAndExecute(); }, 10000);
    logger.info(`[EXECUTOR] Loop Sniper ativado.`);
  },

  async monitorAndExecute() {
    try {
      const allPositions = await bybitService.getPosition() || [];
      const activePositions = allPositions.filter(p => parseFloat(p.size || 0) > 0);

      if (activePositions.length > 0) {
        for (const pos of activePositions) { await this.handleDynamicManagement(pos); }
        return;
      }
      await this.checkAIRecommendations();
    } catch (e) { logger.error(`[EXECUTOR] Erro: ${e.message}`); }
  },

  async handleDynamicManagement(position) {
    const symbol = this.normalizeSymbol(position.symbol);
    const baseUrl = `http://localhost:${process.env.PORT || 10000}`;

    try {
      const scannerResp = await axios.get(`${baseUrl}/api/scanner/status`);
      const snapshot = (scannerResp.data?.data || []).find(s => this.normalizeSymbol(s.coin_id) === symbol);

      if (!snapshot || !this.brainInstance) return;

      const op = (await db.query("SELECT * FROM trading_ai.operations WHERE symbol = $1 AND status = 'OPEN'", [symbol])).rows[0];
      if (!op) return;

      const decision = this.brainInstance.intelligence.analyzeLivePosition(snapshot, {
          ...op, entry_price: parseFloat(op.entry_price) / 10000000000
      });

      this.lastReasons[symbol] = decision.reason;

      if (decision.action !== 'hold') {
          await this.executeAction(symbol, decision, op, position);
      }
    } catch (err) {}
  },

  async checkAIRecommendations() {
    if (!this.brainInstance) return;
    const signals = this.brainInstance.getRecommendations();
    const best = signals.filter(s => (s.decision === 'enter' || s.decision === 'ENTRY') && s.confidence >= 0.60)[0];
    
    if (best) {
        const symbol = this.normalizeSymbol(best.coin_id);
        this.isProcessingEntry = true;
        try {
            const balance = await bybitService.getWalletBalance();
            const price = await bybitService.getTickerPrice(symbol);
            let amount = Math.max(5.2, balance * 0.30);
            if (amount > balance * 0.95) amount = balance * 0.95;

            if (balance >= 5.2) {
                const qty = await this.calculateQuantity(symbol, amount, price);
                await bybitService.placeOrder(symbol, 'Buy', 'Market', qty);
                const scaledPrice = BigInt(Math.round(price * 10000000000));
                await db.query('INSERT INTO trading_ai.operations (symbol, side, entry_price, status) VALUES ($1, $2, $3, $4)', [symbol, 'Buy', scaledPrice, 'OPEN']);
            }
        } finally { this.isProcessingEntry = false; }
    }
  },

  async executeAction(symbol, decision, op, pos) {
      try {
          if (decision.action === 'move_stop') {
              await bybitService.setTradingStop(symbol, decision.params.new_stop.toString());
          } else if (decision.action === 'activate_trailing') {
              await bybitService.setTradingStop(symbol, null, null, decision.params.trailing_stop.toString());
          } else if (decision.action === 'partial_exit') {
              const qty = (parseFloat(pos.size) * 0.5).toString();
              await bybitService.placeOrder(symbol, 'Sell', 'Market', qty, null, null, null, true);
          } else if (decision.action === 'close') {
              await bybitService.placeOrder(symbol, 'Sell', 'Market', pos.size, null, null, null, true);
              await db.query("UPDATE trading_ai.operations SET status = 'CLOSED', close_time = NOW() WHERE symbol = $1 AND status = 'OPEN'", [symbol]);
          }
          
          const queries = require('../../../ai-brain/src/database/queries');
          await queries.updateOperationDynamic(symbol, { reason: decision.reason });
      } catch (e) { logger.error(`Action Error: ${e.message}`); }
  },

  async calculateQuantity(symbol, amount, price) {
    const inst = await bybitService.getInstrumentInfo(symbol);
    const step = inst?.lotSizeFilter?.qtyStep || '1';
    const prec = Math.max(0, Math.log10(1/parseFloat(step)));
    return (Math.floor((amount/price)/parseFloat(step))*parseFloat(step)).toFixed(prec);
  }
};

module.exports = executorService;
