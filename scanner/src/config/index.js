require('dotenv').config();

const config = {
  // Database
  database: {
    url: process.env.DATABASE_URL,
  },

  // Server
  server: {
    port: parseInt(process.env.PORT) || 3001,
    env: process.env.NODE_ENV || 'development',
  },

  // Scanner
  scanner: {
    coinsCount: parseInt(process.env.SCANNER_COINS_COUNT) || 100,
    updateInterval: parseInt(process.env.SCANNER_UPDATE_INTERVAL) || 60000,
    timeframes: (process.env.SCANNER_TIMEFRAMES || '1m,5m,15m,1h,4h,1D').split(','),
  },

  // Indicators
  indicators: {
    ema: process.env.INDICATORS_EMA !== 'false',
    vwap: process.env.INDICATORS_VWAP !== 'false',
    rsi: process.env.INDICATORS_RSI !== 'false',
    macd: process.env.INDICATORS_MACD !== 'false',
    adx: process.env.INDICATORS_ADX !== 'false',
    atr: process.env.INDICATORS_ATR !== 'false',
    bollinger: process.env.INDICATORS_BOLLINGER !== 'false',
    psar: process.env.INDICATORS_PSAR !== 'false',
    stochastic: process.env.INDICATORS_STOCHASTIC !== 'false',
    kama: process.env.INDICATORS_KAMA !== 'false',
    heiken: process.env.INDICATORS_HEIKEN === 'true',
    ichimoku: process.env.INDICATORS_ICHIMOKU === 'true',
    obv: process.env.INDICATORS_OBV !== 'false',
    supertrend: process.env.INDICATORS_SUPERTREND !== 'false',
    
    // EMA Periods
    emaPeriods: (process.env.EMA_PERIODS || '9,21,50,200').split(',').map(Number),
    
    // RSI
    rsiPeriod: parseInt(process.env.RSI_PERIOD) || 14,
    rsiOverbought: parseInt(process.env.RSI_OVERBOUGHT) || 70,
    rsiOversold: parseInt(process.env.RSI_OVERSOLD) || 30,
    
    // MACD
    macdFast: parseInt(process.env.MACD_FAST) || 12,
    macdSlow: parseInt(process.env.MACD_SLOW) || 26,
    macdSignal: parseInt(process.env.MACD_SIGNAL) || 9,
    
    // ADX
    adxPeriod: parseInt(process.env.ADX_PERIOD) || 14,
    
    // ATR
    atrPeriod: parseInt(process.env.ATR_PERIOD) || 14,
    
    // Bollinger
    bollingerPeriod: parseInt(process.env.BOLLINGER_PERIOD) || 20,
    bollingerStdDev: parseInt(process.env.BOLLINGER_STD_DEV) || 2,
    
    // Stochastic
    stochKPeriod: parseInt(process.env.STOCH_K_PERIOD) || 14,
    stochDPeriod: parseInt(process.env.STOCH_D_PERIOD) || 3,
    stochSmooth: parseInt(process.env.STOCH_SMOOTH) || 3,
  },

  // Bybit
  bybit: {
    apiUrl: process.env.BYBIT_API_URL || 'https://api.bybit.com',
    testnet: process.env.BYBIT_TESTNET === 'true',
  },

  // Rate Limiting
  rateLimit: {
    window: parseInt(process.env.RATE_LIMIT_WINDOW) || 15,
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  },

  // CORS
  cors: {
    origin: process.env.CORS_ORIGIN || '*',
  },

  // Logging
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    file: process.env.LOG_FILE === 'true',
    console: process.env.LOG_CONSOLE === 'true',
  },

  // Debug
  debug: process.env.DEBUG === 'true',

  // Score
  score: {
    min: parseInt(process.env.SCORE_MIN) || 0,
    max: parseInt(process.env.SCORE_MAX) || 100,
    weakThreshold: parseInt(process.env.SCORE_WEAK_THRESHOLD) || 30,
    neutralThreshold: parseInt(process.env.SCORE_NEUTRAL_THRESHOLD) || 60,
    goodThreshold: parseInt(process.env.SCORE_GOOD_THRESHOLD) || 80,
    excellentThreshold: parseInt(process.env.SCORE_EXCELLENT_THRESHOLD) || 100,
  },

  // Performance
  performance: {
    maxConcurrentRequests: parseInt(process.env.MAX_CONCURRENT_REQUESTS) || 10,
    requestTimeout: parseInt(process.env.REQUEST_TIMEOUT) || 30000,
    retryAttempts: parseInt(process.env.RETRY_ATTEMPTS) || 3,
    retryDelay: parseInt(process.env.RETRY_DELAY) || 1000,
  },
};

// Validation
if (!config.database.url) {
  throw new Error('DATABASE_URL is required');
}

module.exports = config;
