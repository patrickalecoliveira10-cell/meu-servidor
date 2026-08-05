require('dotenv').config();

const config = {
  // Database
  database: {
    url: process.env.DATABASE_URL,
  },

  // Server
  server: {
    port: parseInt(process.env.PORT) || 3002,
    env: process.env.NODE_ENV || 'development',
  },

  // AI Configuration
  ai: {
    mode: process.env.AI_MODE || 'observation', // observation, operational
    minExamplesForOperation: parseInt(process.env.MIN_EXAMPLES_FOR_OPERATION) || 1000,
    learningRate: parseFloat(process.env.LEARNING_RATE) || 0.01,
    confidenceThreshold: parseFloat(process.env.CONFIDENCE_THRESHOLD) || 0.7,
    maxOperationsPerDay: parseInt(process.env.MAX_OPERATIONS_PER_DAY) || 10,
  },

  // Scanner Connection
  scanner: {
    apiUrl: process.env.SCANNER_API_URL || 'https://trickpps2-scanner.onrender.com',
    pollInterval: parseInt(process.env.SCANNER_POLL_INTERVAL) || 5000,
  },

  // Timeframes
  timeframes: (process.env.AI_TIMEFRAMES || '1m,5m,15m,1h,4h,1D').split(','),

  // Indicators Weights
  indicators: {
    ema: parseFloat(process.env.INDICATOR_EMA_WEIGHT) || 0.15,
    rsi: parseFloat(process.env.INDICATOR_RSI_WEIGHT) || 0.15,
    macd: parseFloat(process.env.INDICATOR_MACD_WEIGHT) || 0.15,
    adx: parseFloat(process.env.INDICATOR_ADX_WEIGHT) || 0.10,
    atr: parseFloat(process.env.INDICATOR_ATR_WEIGHT) || 0.10,
    bollinger: parseFloat(process.env.INDICATOR_BOLLINGER_WEIGHT) || 0.10,
    stochastic: parseFloat(process.env.INDICATOR_STOCHASTIC_WEIGHT) || 0.10,
    supertrend: parseFloat(process.env.INDICATOR_SUPERTREND_WEIGHT) || 0.15,
  },

  // Risk Management
  risk: {
    maxRiskPerOperation: parseFloat(process.env.MAX_RISK_PER_OPERATION) || 0.02,
    maxDailyLoss: parseFloat(process.env.MAX_DAILY_LOSS) || 0.05,
    minWinRate: parseFloat(process.env.MIN_WIN_RATE) || 0.60,
  },

  // Simulation
  simulation: {
    enabled: process.env.SIMULATION_ENABLED === 'true',
    duration: parseInt(process.env.SIMULATION_DURATION) || 30,
  },

  // Logging
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    file: process.env.LOG_FILE === 'true',
    console: process.env.LOG_CONSOLE !== 'false', // Default true se não for 'false'
  },

  // CORS
  cors: {
    origin: process.env.CORS_ORIGIN || '*',
  },

  // Rate Limiting
  rateLimit: {
    window: parseInt(process.env.RATE_LIMIT_WINDOW) || 15,
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  },

  // Debug
  debug: process.env.DEBUG === 'true',
};

// Validation
if (!config.database.url) {
  throw new Error('DATABASE_URL is required');
}

module.exports = config;
