const bybitService = require('../services/bybit');
const indicatorsCalculator = require('../indicators');
const scoreCalculator = require('./scoreCalculator');
const queries = require('../database/queries');
const logger = require('../logs/logger');
const config = require('../config');
const axios = require('axios'); // Adicionado para comunicar com a IA

class MarketScanner {
  constructor() {
    this.isRunning = false;
    this.currentSessionId = null;
    this.scanInterval = null;
    this.stats = {
      coinsScanned: 0,
      snapshotsCreated: 0,
      errorsCount: 0,
      startTime: null,
      lastUpdateTime: null
    };
  }

  async start() {
    if (this.isRunning) {
      logger.warn('Scanner is already running');
      return;
    }

    logger.info('Starting Market Scanner...');
    this.isRunning = true;
    this.stats.startTime = Date.now();

    // Create scanner session
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

    // Start scanning loop
    await this.scanCycle();
    this.scanInterval = setInterval(() => {
      this.scanCycle().catch(error => {
        logger.error('Error in scan cycle:', error);
      });
    }, config.scanner.updateInterval);

    logger.info('Market Scanner started successfully');
  }

  async stop() {
    if (!this.isRunning) {
      logger.warn('Scanner is not running');
      return;
    }

    logger.info('Stopping Market Scanner...');
    this.isRunning = false;

    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }

    // Update session
    if (this.currentSessionId) {
      try {
        const duration = Math.floor((Date.now() - this.stats.startTime) / 1000);
        await queries.updateScannerSession(this.currentSessionId, {
          status: 'stopped',
          end_time: new Date(),
          coins_scanned: this.stats.coinsScanned,
          snapshots_created: this.stats.snapshotsCreated,
          errors_count: this.stats.errorsCount,
          duration_seconds: duration
        });
        logger.info('Scanner session updated');
      } catch (error) {
        logger.error('Failed to update scanner session:', error);
      }
    }

    logger.info('Market Scanner stopped');
  }

  async scanCycle() {
    if (!this.isRunning) return;

    const cycleStartTime = Date.now();
    logger.info('Starting scan cycle...');

    try {
      // Get top coins from Bybit
      const coins = await bybitService.getTopCoins(config.scanner.coinsCount);
      logger.info(`Fetched ${coins.length} coins from Bybit`);

      // Process each coin for each timeframe
      for (const coin of coins) {
        // Register/Update coin in database to ensure FK consistency
        try {
          await queries.upsertCoin(coin);
        } catch (error) {
          logger.error(`Error upserting coin ${coin.symbol}:`, error.message);
        }

        for (const timeframe of config.scanner.timeframes) {
          await this.processCoin(coin, timeframe);
        }
        
        this.stats.coinsScanned++;
      }

      this.stats.lastUpdateTime = Date.now();
      const cycleDuration = Date.now() - cycleStartTime;
      
      logger.info('Scan cycle completed', {
        coinsScanned: this.stats.coinsScanned,
        snapshotsCreated: this.stats.snapshotsCreated,
        errorsCount: this.stats.errorsCount,
        duration: cycleDuration
      });

    } catch (error) {
      this.stats.errorsCount++;
      logger.error('Error in scan cycle:', error);
    }
  }

  async processCoin(coin, timeframe) {
    try {
      // Fetch klines
      const klines = await bybitService.getKlines(coin.symbol, timeframe, 200);
      
      if (klines.length < 50) {
        logger.warn(`Insufficient data for ${coin.symbol} ${timeframe}`);
        return;
      }

      const latestKline = klines[klines.length - 1];
      
      // Calculate indicators
      const indicators = indicatorsCalculator.calculateAll(klines);
      
      // Calculate score
      const scoreResult = scoreCalculator.calculateScore(
        {
          close: latestKline.close,
          volume: latestKline.volume,
          priceChange24h: coin.priceChange24h
        },
        indicators
      );

      // Calculate volatility (using ATR)
      const volatility = indicators.atr 
        ? (indicators.atr / latestKline.close) * 100 
        : 0;

      // Create market snapshot
      const snapshot = {
        coin_id: coin.symbol,
        timeframe: timeframe,
        open: latestKline.open,
        high: latestKline.high,
        low: latestKline.low,
        close: latestKline.close,
        volume: latestKline.volume,
        indicators: indicators,
        timestamp: typeof latestKline.timestamp === 'string' 
          ? new Date(latestKline.timestamp).getTime() 
          : latestKline.timestamp
      };

      // Save to database
      await queries.insertMarketSnapshot(snapshot);
      this.stats.snapshotsCreated++;

      // Convert timestamp to Unix timestamp if it's a string
      const unixTimestamp = typeof latestKline.timestamp === 'string' 
        ? new Date(latestKline.timestamp).getTime() 
        : latestKline.timestamp;

      // Save indicators
      await this.saveIndicators(coin.symbol, timeframe, indicators, unixTimestamp);

      // Save scanner result
      await queries.insertScannerResult({
        session_id: this.currentSessionId,
        coin_id: coin.symbol,
        timeframe: timeframe,
        score: scoreResult.score,
        price: latestKline.close,
        volume: latestKline.volume,
        volatility: volatility,
        indicators_summary: {
          score: scoreResult,
          indicators: indicators
        },
        timestamp: unixTimestamp
      });

      // NOTIFICAR IA (Servidor 2) para processamento imediato e aprendizado
      try {
        const aiUrl = process.env.AI_BRAIN_URL || 'https://trickappserv2.onrender.com';
        // Ajustado de /api/ai/snapshot para /api/snapshot (rota correta do Servidor 2)
        axios.post(`${aiUrl}/api/snapshot`, snapshot).catch((err) => {
          logger.error(`Failed to send snapshot to AI at ${aiUrl}: ${err.message}`);
        });
      } catch (aiErr) {
        logger.error(`Error in notifying AI: ${aiErr.message}`);
      }

      logger.debug(`Processed ${coin.symbol} ${timeframe}`, {
        score: scoreResult.score,
        category: scoreResult.category
      });

    } catch (error) {
      this.stats.errorsCount++;
      logger.error(`Error processing ${coin.symbol} ${timeframe}:`, error);
    }
  }

  async saveIndicators(coinId, timeframe, indicators, timestamp) {
    const indicatorPromises = [];

    // Save EMA indicators
    if (indicators.ema) {
      Object.keys(indicators.ema).forEach(key => {
        const period = parseInt(key.replace('ema_', ''));
        if (indicators.ema[key] != null && !isNaN(indicators.ema[key])) {
          indicatorPromises.push(
            queries.insertIndicator({
              type: 'ema',
              coin_id: coinId,
              timeframe: timeframe,
              period: period,
              value: indicators.ema[key],
              signal: null,
              timestamp: timestamp
            })
          );
        }
      });
    }

    // Save RSI
    if (indicators.rsi && indicators.rsi.value != null && !isNaN(indicators.rsi.value)) {
      indicatorPromises.push(
        queries.insertIndicator({
          type: 'rsi',
          coin_id: coinId,
          timeframe: timeframe,
          period: config.indicators.rsiPeriod,
          value: indicators.rsi.value,
          signal: indicators.rsi.signal,
          timestamp: timestamp
        })
      );
    }

    // Save MACD
    if (indicators.macd && indicators.macd.macd != null && !isNaN(indicators.macd.macd)) {
      indicatorPromises.push(
        queries.insertIndicator({
          type: 'macd',
          coin_id: coinId,
          timeframe: timeframe,
          period: config.indicators.macdFast,
          value: indicators.macd.macd,
          signal: indicators.macd.signal,
          timestamp: timestamp
        })
      );
    }

    // Save other indicators similarly...
    await Promise.all(indicatorPromises);
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      sessionId: this.currentSessionId,
      stats: {
        ...this.stats,
        uptime: this.stats.startTime ? Math.floor((Date.now() - this.stats.startTime) / 1000) : 0
      },
      config: {
        coinsCount: config.scanner.coinsCount,
        updateInterval: config.scanner.updateInterval,
        timeframes: config.scanner.timeframes
      }
    };
  }
}

module.exports = new MarketScanner();
