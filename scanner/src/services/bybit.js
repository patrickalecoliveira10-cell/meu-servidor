const axios = require('axios');
const config = require('../config');
const logger = require('../logs/logger');

class BybitService {
  constructor() {
    this.baseUrl = config.bybit.apiUrl;
    this.timeout = config.performance.requestTimeout;
    this.retryAttempts = config.performance.retryAttempts;
    this.retryDelay = config.performance.retryDelay;
  }

  async sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async fetchWithRetry(url, options = {}, retries = this.retryAttempts) {
    for (let i = 0; i < retries; i++) {
      try {
        const response = await axios({
          url,
          timeout: this.timeout,
          ...options
        });
        return response.data;
      } catch (error) {
        if (i === retries - 1) throw error;
        
        logger.warn(`Request failed, retrying (${i + 1}/${retries})`, {
          url,
          error: error.message
        });
        
        await this.sleep(this.retryDelay * (i + 1));
      }
    }
  }

  async getTickers() {
    try {
      const url = `${this.baseUrl}/v5/market/tickers?category=linear`;
      const data = await this.fetchWithRetry(url);
      
      if (data.retCode !== 0) {
        throw new Error(`Bybit API error: ${data.retMsg}`);
      }
      
      return data.result.list
        .filter(ticker => ticker.symbol.endsWith('USDT'))
        .map(ticker => ({
          symbol: ticker.symbol,
          lastPrice: parseFloat(ticker.lastPrice),
          priceChange24h: parseFloat(ticker.price24hPcnt) * 100,
          volume24h: parseFloat(ticker.turnover24h),
          high24h: parseFloat(ticker.highPrice24h),
          low24h: parseFloat(ticker.lowPrice24h),
          bidPrice: parseFloat(ticker.bid1Price),
          askPrice: parseFloat(ticker.ask1Price),
          bidQty: parseFloat(ticker.bid1Size),
          askQty: parseFloat(ticker.ask1Size),
        }));
    } catch (error) {
      logger.error('Error fetching tickers from Bybit:', error);
      throw error;
    }
  }

  async getKlines(symbol, interval, limit = 200) {
    try {
      // Bybit V5 intervals: 1,3,5,15,30,60,120,240,360,720,D,M,W
      const intervalMap = {
        '1m': '1',
        '3m': '3',
        '5m': '5',
        '15m': '15',
        '30m': '30',
        '1h': '60',
        '2h': '120',
        '4h': '240',
        '6h': '360',
        '12h': '720',
        '1d': 'D',
        '1D': 'D',
        '1w': 'W',
        '1W': 'W',
        '1M': 'M'
      };

      const bybitInterval = intervalMap[interval] || interval;
      const url = `${this.baseUrl}/v5/market/kline?category=linear&symbol=${symbol}&interval=${bybitInterval}&limit=${limit}`;
      const data = await this.fetchWithRetry(url);
      
      if (data.retCode !== 0) {
        throw new Error(`Bybit API error: ${data.retMsg} (Symbol: ${symbol}, Interval: ${bybitInterval})`);
      }
      
      return data.result.list.map(kline => ({
        timestamp: parseInt(kline[0]),
        open: parseFloat(kline[1]),
        high: parseFloat(kline[2]),
        low: parseFloat(kline[3]),
        close: parseFloat(kline[4]),
        volume: parseFloat(kline[5]),
        turnover: parseFloat(kline[6]),
      })).reverse();
    } catch (error) {
      logger.error(`Error fetching klines for ${symbol}:`, error);
      throw error;
    }
  }

  async getOrderBook(symbol, limit = 20) {
    try {
      const url = `${this.baseUrl}/v5/market/orderbook?category=linear&symbol=${symbol}&limit=${limit}`;
      const data = await this.fetchWithRetry(url);
      
      if (data.retCode !== 0) {
        throw new Error(`Bybit API error: ${data.retMsg}`);
      }
      
      const result = data.result;
      return {
        bids: result.b.map(bid => ({
          price: parseFloat(bid[0]),
          quantity: parseFloat(bid[1])
        })),
        asks: result.a.map(ask => ({
          price: parseFloat(ask[0]),
          quantity: parseFloat(ask[1])
        })),
        timestamp: result.ts
      };
    } catch (error) {
      logger.error(`Error fetching orderbook for ${symbol}:`, error);
      throw error;
    }
  }

  async get24hrTicker(symbol) {
    try {
      const url = `${this.baseUrl}/v5/market/tickers?category=linear&symbol=${symbol}`;
      const data = await this.fetchWithRetry(url);
      
      if (data.retCode !== 0) {
        throw new Error(`Bybit API error: ${data.retMsg}`);
      }
      
      const ticker = data.result.list[0];
      return {
        symbol: ticker.symbol,
        lastPrice: parseFloat(ticker.lastPrice),
        priceChange24h: parseFloat(ticker.price24hPcnt) * 100,
        volume24h: parseFloat(ticker.turnover24h),
        high24h: parseFloat(ticker.highPrice24h),
        low24h: parseFloat(ticker.lowPrice24h),
        bidPrice: parseFloat(ticker.bid1Price),
        askPrice: parseFloat(ticker.ask1Price),
        spread: ((parseFloat(ticker.ask1Price) - parseFloat(ticker.bid1Price)) / parseFloat(ticker.lastPrice)) * 100,
      };
    } catch (error) {
      logger.error(`Error fetching 24hr ticker for ${symbol}:`, error);
      throw error;
    }
  }

  async getTopCoins(limit = 100) {
    try {
      const tickers = await this.getTickers();
      
      return tickers
        .sort((a, b) => b.volume24h - a.volume24h)
        .slice(0, limit);
    } catch (error) {
      logger.error('Error fetching top coins:', error);
      throw error;
    }
  }

  async testConnection() {
    try {
      const url = `${this.baseUrl}/v5/market/tickers?category=linear&limit=1`;
      const data = await this.fetchWithRetry(url);
      
      if (data.retCode === 0) {
        logger.info('Bybit API connection successful (Linear)');
        return true;
      } else {
        logger.error('Bybit API connection failed:', data.retMsg);
        return false;
      }
    } catch (error) {
      logger.error('Bybit API connection error:', error);
      return false;
    }
  }
}

module.exports = new BybitService();
