const bybitService = require('../services/bybit');
const indicatorsCalculator = require('../indicators');
const queries = require('../database/queries');
const logger = require('../logs/logger');
const config = require('../config');

class MarketScanner {
  constructor() {
    this.isRunning = false;
    this.brainInstance = null;
  }

  setBrain(brain) { this.brainInstance = brain; }

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    logger.info('>>> MODO ECONOMIA DE BANDA: Scanner Iniciado.');
    
    // Ciclo de scan a cada 15 segundos para poupar o Render e Supabase
    setInterval(() => this.scanCycle(), 15000);
  }

  async scanCycle() {
    try {
      const coins = await bybitService.getTopCoins(15); // Apenas as 15 principais
      for (const coin of coins) {
        await this.processCoin(coin, '15'); // Apenas timeframe de 15m para economizar
      }
    } catch (e) { logger.error('Erro no ciclo de scan:', e.message); }
  }

  async processCoin(coin, timeframe) {
    try {
      const klines = await bybitService.getKlines(coin.symbol, timeframe, 100);
      if (klines.length < 50) return;

      const indicators = indicatorsCalculator.calculateAll(klines);
      const latest = klines[klines.length - 1];

      const snapshot = {
        coin_id: coin.symbol,
        timeframe,
        close: latest.close,
        indicators,
        timestamp: Date.now()
      };

      // IA PROCESSA EM MEMÓRIA (Zero Bandwidth)
      if (this.brainInstance) {
        this.brainInstance.processMarketSnapshot(snapshot).catch(() => {});
      }

      // SALVA SÓ O RESULTADO PARA O APP (Upsert otimizado)
      await queries.insertScannerResult({
        coin_id: coin.symbol,
        timeframe,
        price: latest.close,
        indicators_summary: { 
            rsi: indicators.rsi?.value, 
            trend: indicators.supertrend?.signal 
        }
      });
    } catch (e) {}
  }
}

module.exports = new MarketScanner();
