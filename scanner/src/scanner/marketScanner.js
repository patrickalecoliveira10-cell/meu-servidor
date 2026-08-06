const bybitService = require('../services/bybit');
const privateBybitService = require('../../../executor/src/services/bybit'); // Importa o serviço com suporte a posições
const indicatorsCalculator = require('../indicators');
const scoreCalculator = require('./scoreCalculator');
const queries = require('../database/queries');
const logger = require('../logs/logger');
const config = require('../config');
const axios = require('axios');

class MarketScanner {
  constructor() {
    this.isRunning = false;
    this.currentSessionId = null;
    this.scanInterval = null;
    this.brainInstance = null;
    this.stats = {
      coinsScanned: 0,
      snapshotsCreated: 0,
      errorsCount: 0,
      startTime: null,
      lastUpdateTime: null
    };
  }

  setBrain(brain) {
    this.brainInstance = brain;
    logger.info('[SCANNER] Brain instance linked for direct processing');
  }

  async start() {
    if (this.isRunning) {
      logger.warn('Scanner is already running');
      return;
    }

    logger.info('Starting Market Scanner...');
    this.isRunning = true;
    this.stats.startTime = Date.now();

    try {
      this.currentSessionId = await queries.createScannerSession({
        coins_count: config.scanner.coinsCount,
        timeframes: config.scanner.timeframes
      });
      logger.info(`Scanner session created: ${this.currentSessionId}`);
    } catch (error) {
      logger.error('Failed to create scanner session:', error);
      this.isRunning = false;
      return;
    }

    await this.scanCycle();
    this.scanInterval = setInterval(() => {
      this.scanCycle().catch(error => {
        logger.error('Error in scan cycle:', error);
      });
    }, config.scanner.updateInterval);

    logger.info('Market Scanner started successfully');
  }

  async stop() {
    if (!this.isRunning) return;
    this.isRunning = false;
    if (this.scanInterval) clearInterval(this.scanInterval);
    logger.info('Market Scanner stopped');
  }

  async scanCycle() {
    if (!this.isRunning) return;

    const cycleStartTime = Date.now();
    logger.info('Starting scan cycle...');

    try {
      // 1. Buscar moedas com posições abertas usando o serviço do EXECUTOR
      let activeSymbols = [];
      try {
          const allPositions = await privateBybitService.getPosition() || [];
          activeSymbols = allPositions
            .filter(p => parseFloat(p.size || 0) > 0)
            .map(p => p.symbol);
      } catch (e) {
          logger.warn('[SCANNER] Could not fetch positions from private service, using top coins only');
      }

      // 2. Buscar as top coins
      let allCoins = await bybitService.getTopCoins(config.scanner.coinsCount);

      // 3. Priorização Inteligente
      const prioritizedCoins = [];
      const seen = new Set();

      for (const symbol of activeSymbols) {
        const fullData = allCoins.find(c => c.symbol === symbol);
        if (fullData) {
          prioritizedCoins.push(fullData);
          seen.add(symbol);
        } else {
          prioritizedCoins.push({ symbol, priceChange24h: 0 });
          seen.add(symbol);
        }
      }

      for (const coin of allCoins) {
        if (!seen.has(coin.symbol)) {
          prioritizedCoins.push(coin);
          seen.add(coin.symbol);
        }
      }

      logger.info(`[SCANNER] Cycle: ${prioritizedCoins.length} coins. Active: ${activeSymbols.join(', ') || 'none'}`);

      for (const coin of prioritizedCoins) {
        try { await queries.upsertCoin(coin); } catch (e) {}
        for (const timeframe of config.scanner.timeframes) {
          await this.processCoin(coin, timeframe);
        }
        this.stats.coinsScanned++;
      }

      this.stats.lastUpdateTime = Date.now();
      logger.info('Scan cycle completed');

    } catch (error) {
      this.stats.errorsCount++;
      logger.error('Error in scan cycle:', error);
    }
  }

  async processCoin(coin, timeframe) {
    try {
      const klines = await bybitService.getKlines(coin.symbol, timeframe, 200);
      if (klines.length < 50) return;

      const latestKline = klines[klines.length - 1];
      const indicators = indicatorsCalculator.calculateAll(klines);
      
      const scoreResult = scoreCalculator.calculateScore(
        { close: latestKline.close, volume: latestKline.volume, priceChange24h: coin.priceChange24h },
        indicators
      );

      const snapshot = {
        coin_id: coin.symbol,
        timeframe: timeframe,
        open: latestKline.open,
        high: latestKline.high,
        low: latestKline.low,
        close: latestKline.close,
        volume: latestKline.volume,
        indicators: indicators,
        timestamp: Date.now()
      };

      await queries.insertMarketSnapshot(snapshot);
      this.stats.snapshotsCreated++;

      // Salva Indicadores e Resultados para o App Android
      await this.saveIndicators(coin.symbol, timeframe, indicators, snapshot.timestamp);
      await queries.insertScannerResult({
        session_id: this.currentSessionId,
        coin_id: coin.symbol,
        timeframe: timeframe,
        score: scoreResult.score,
        price: latestKline.close,
        volume: latestKline.volume,
        volatility: indicators.atr ? (indicators.atr / latestKline.close) * 100 : 0,
        indicators_summary: { score: scoreResult, indicators: indicators },
        timestamp: snapshot.timestamp
      });

      // Notificar IA diretamente (Modo Unificado)
      if (this.brainInstance) {
        this.brainInstance.processMarketSnapshot(snapshot).catch(err =>
          logger.error(`[Scanner -> Brain] Error: ${err.message}`)
        );
      }

    } catch (error) {
      this.stats.errorsCount++;
      logger.error(`Error processing ${coin.symbol}:`, error.message);
    }
  }

  async saveIndicators(coinId, timeframe, indicators, timestamp) {
    const promises = [];
    if (indicators.ema) {
      Object.keys(indicators.ema).forEach(key => {
        promises.push(queries.insertIndicator({
          type: 'ema', coin_id: coinId, timeframe: timeframe,
          period: parseInt(key.replace('ema_', '')), value: indicators.ema[key], timestamp
        }));
      });
    }
    if (indicators.rsi) {
      promises.push(queries.insertIndicator({
        type: 'rsi', coin_id: coinId, timeframe: timeframe,
        period: 14, value: indicators.rsi.value, signal: indicators.rsi.signal, timestamp
      }));
    }
    await Promise.all(promises).catch(e => logger.error('Error saving indicators:', e.message));
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      stats: { ...this.stats, uptime: this.stats.startTime ? Math.floor((Date.now() - this.stats.startTime) / 1000) : 0 }
    };
  }
}

module.exports = new MarketScanner();
