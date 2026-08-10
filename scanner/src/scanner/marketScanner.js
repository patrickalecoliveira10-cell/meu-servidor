const bybitService = require('../services/bybit');
const indicatorsCalculator = require('../indicators');
const queries = require('../database/queries');
const logger = require('../logs/logger');

class MarketScanner {
  constructor() {
    this.isRunning = false;
    this.brainInstance = null;
  }

  setBrain(brain) { this.brainInstance = brain; }

  async start() {
    this.isRunning = true;
    logger.info('>>> MODO ECONOMIA ATIVO (Zero Snapshots no DB)');
    setInterval(() => this.scanCycle(), 20000); // A cada 20 segundos
  }

  async scanCycle() {
    try {
      const coins = await bybitService.getTopCoins(15);
      for (const coin of coins) {
        await this.processCoin(coin, '15');
      }
    } catch (e) { logger.error('Scanner Cycle Error:', e.message); }
  }

  async processCoin(coin, timeframe) {
    try {
      const klines = await bybitService.getKlines(coin.symbol, timeframe, 80);
      if (klines.length < 50) return;

      const indicators = indicatorsCalculator.calculateAll(klines);
      const latest = klines[klines.length - 1];

      // IA processa EM MEMÓRIA (não gasta bandwidth do Supabase)
      if (this.brainInstance) {
        this.brainInstance.processMarketSnapshot({
          coin_id: coin.symbol,
          timeframe,
          close: latest.close,
          indicators,
          timestamp: Date.now()
        }).catch(() => {});
      }

      // Salva apenas o essencial para o App Android
      await queries.insertScannerResult({
        coin_id: coin.symbol,
        timeframe,
        price: latest.close,
        indicators_summary: { rsi: indicators.rsi?.value, trend: indicators.supertrend?.signal }
      });
    } catch (e) {}
  }
}

module.exports = new MarketScanner();
