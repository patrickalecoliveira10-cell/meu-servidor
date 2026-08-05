const axios = require('axios');
const CryptoJS = require('crypto-js');
const config = require('../config');
const logger = require('../logs/logger.js');

class BybitService {
  constructor() {
    this.apiKey = config.bybit.apiKey;
    this.apiSecret = config.bybit.apiSecret;
    this.baseUrl = config.bybit.apiUrl;
    this.testnet = config.bybit.testnet;
  }

  async request(endpoint, method = 'GET', params = {}) {
    try {
      const timestamp = Date.now().toString();
      const recvWindow = '5000';

      let queryString = '';
      let bodyString = '';

      if (method === 'GET') {
        queryString = Object.keys(params)
          .sort()
          .map(key => `${key}=${params[key]}`)
          .join('&');
      } else {
        bodyString = JSON.stringify(params);
      }

      const signString = timestamp + this.apiKey + recvWindow + (method === 'GET' ? queryString : bodyString);
      const signature = CryptoJS.HmacSHA256(signString, this.apiSecret).toString();

      const headers = {
        'X-BAPI-API-KEY': this.apiKey,
        'X-BAPI-SIGN': signature,
        'X-BAPI-TIMESTAMP': timestamp,
        'X-BAPI-RECV-WINDOW': recvWindow,
        'Content-Type': 'application/json'
      };

      const url = `${this.baseUrl}${endpoint}${queryString ? '?' + queryString : ''}`;

      const response = await axios({
        method,
        url,
        headers,
        data: method === 'POST' ? params : undefined
      });

      if (response.data.retCode !== 0) {
        const errorMsg = `Bybit Error ${response.data.retCode}: ${response.data.retMsg}`;
        logger.error(`[BYBIT_API] ${errorMsg} | Params: ${JSON.stringify(params)}`);
        throw new Error(errorMsg);
      }

      return response.data.result;
    } catch (error) {
      const errorDetail = error.response ? JSON.stringify(error.response.data) : error.message;
      logger.error(`Bybit API request failed [${method} ${endpoint}]: ${errorDetail}`);
      throw new Error(errorDetail);
    }
  }

  async testConnection() {
    try {
      const result = await this.request('/v5/account/wallet-balance', 'GET', { accountType: 'UNIFIED' });
      logger.info('Bybit connection successful');
      return true;
    } catch (error) {
      logger.error('Bybit connection failed:', error.message);
      return false;
    }
  }

  async getWalletBalance() {
    try {
      const result = await this.request('/v5/account/wallet-balance', 'GET', { accountType: 'UNIFIED', coin: 'USDT' });
      const totalBalance = result.list[0]?.coin[0]?.walletBalance || 0;
      return parseFloat(totalBalance);
    } catch (error) {
      logger.error('Error getting wallet balance:', error.message);
      return 0;
    }
  }

  async getTickerPrice(symbol) {
    try {
      const result = await this.request('/v5/market/tickers', 'GET', { category: 'linear', symbol });
      return parseFloat(result.list[0]?.lastPrice || 0);
    } catch (error) {
      logger.error(`Error getting ticker price for ${symbol}:`, error.message);
      return 0;
    }
  }

  async getInstrumentInfo(symbol) {
    try {
      const result = await this.request('/v5/market/instruments-info', 'GET', { category: 'linear', symbol });
      return result.list[0];
    } catch (error) {
      logger.error(`Error getting instrument info for ${symbol}:`, error.message);
      return null;
    }
  }

  async getBalance() {
    try {
      const result = await this.request('/v5/account/wallet-balance', 'GET', { accountType: 'UNIFIED' });
      return result.list[0];
    } catch (error) {
      logger.error('Error getting balance:', error.message);
      throw error;
    }
  }

  async placeOrder(symbol, side, orderType, qty, price = null, stopLoss = null, takeProfit = null) {
    try {
      const params = {
        category: 'linear',
        symbol,
        side,
        orderType,
        qty,
        timeInForce: 'GTC'
      };

      if (price && orderType === 'LIMIT') {
        params.price = price;
      }

      if (stopLoss) params.stopLoss = stopLoss.toString();
      if (takeProfit) params.takeProfit = takeProfit.toString();

      const result = await this.request('/v5/order/create', 'POST', params);
      logger.info(`Order placed: ${side} ${qty} ${symbol}${stopLoss ? ' SL:' + stopLoss : ''}${takeProfit ? ' TP:' + takeProfit : ''}`);
      return result;
    } catch (error) {
      logger.error('Error placing order:', error.message);
      throw error;
    }
  }

  async setTradingStop(symbol, stopLoss = null, takeProfit = null, trailingStop = null) {
    try {
      const params = {
        category: 'linear',
        symbol,
        tpslMode: 'Full'
      };

      if (stopLoss) params.stopLoss = stopLoss.toString();
      if (takeProfit) params.takeProfit = takeProfit.toString();
      if (trailingStop) params.trailingStop = trailingStop.toString();

      const result = await this.request('/v5/position/trading-stop', 'POST', params);
      logger.info(`Trading stop updated for ${symbol}: SL=${stopLoss}, TP=${takeProfit}, TS=${trailingStop}`);
      return result;
    } catch (error) {
      logger.error(`Error setting trading stop for ${symbol}:`, error.message);
      throw error;
    }
  }

  async cancelOrder(orderId, symbol) {
    try {
      const params = {
        category: 'linear',
        symbol,
        orderId
      };

      const result = await this.request('/v5/order/cancel', 'POST', params);
      logger.info(`Order cancelled: ${orderId}`);
      return result;
    } catch (error) {
      logger.error('Error cancelling order:', error.message);
      throw error;
    }
  }

  async cancelAllOrders(symbol) {
    try {
      const params = {
        category: 'linear',
        symbol
      };

      const result = await this.request('/v5/order/cancel-all', 'POST', params);
      logger.info(`All orders cancelled for ${symbol}`);
      return result;
    } catch (error) {
      logger.error('Error cancelling all orders:', error.message);
      throw error;
    }
  }

  async getOpenOrders(symbol = null) {
    try {
      const params = {
        category: 'linear'
      };

      if (symbol) {
        params.symbol = symbol;
      }

      const result = await this.request('/v5/order/realtime', 'GET', params);
      return result.list;
    } catch (error) {
      logger.error('Error getting open orders:', error.message);
      throw error;
    }
  }

  async getPosition(symbol = null) {
    try {
      // Futures trading has positions
      const params = {
        category: 'linear',
        settleCoin: 'USDT'
      };

      if (symbol) {
        params.symbol = symbol;
      }

      const result = await this.request('/v5/position/list', 'GET', params);
      return result.list;
    } catch (error) {
      logger.error('Error getting positions:', error.message);
      throw error;
    }
  }

  async getOrderHistory(symbol = null, limit = 50) {
    try {
      const params = {
        category: 'linear',
        limit
      };

      if (symbol) {
        params.symbol = symbol;
      }

      const result = await this.request('/v5/order/history', 'GET', params);
      return result.list;
    } catch (error) {
      logger.error('Error getting order history:', error.message);
      throw error;
    }
  }
}

module.exports = new BybitService();
