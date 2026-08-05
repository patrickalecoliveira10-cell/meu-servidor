require('dotenv').config();

module.exports = {
  server: {
    port: process.env.PORT || 3003,
    env: process.env.NODE_ENV || 'development'
  },
  database: {
    url: process.env.DATABASE_URL
  },
  bybit: {
    apiKey: process.env.BYBIT_API_KEY,
    apiSecret: process.env.BYBIT_API_SECRET,
    apiUrl: process.env.BYBIT_API_URL || 'https://api.bybit.com',
    testnet: process.env.BYBIT_TESTNET === 'true'
  },
  aiBrain: {
    apiUrl: process.env.AI_BRAIN_API_URL,
    pollInterval: parseInt(process.env.AI_BRAIN_POLL_INTERVAL) || 5000
  },
  executor: {
    mode: process.env.EXECUTOR_MODE || 'automatic',
    minTradeAmount: parseFloat(process.env.MIN_TRADE_AMOUNT) || 10,
    maxPositions: parseInt(process.env.MAX_POSITIONS) || 5,
    emergencyMode: process.env.EMERGENCY_MODE === 'true'
  },
  rateLimit: {
    window: parseInt(process.env.RATE_LIMIT_WINDOW) || 15,
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100
  },
  cors: {
    origin: process.env.CORS_ORIGIN || '*'
  },
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    file: process.env.LOG_FILE === 'true',
    console: process.env.LOG_CONSOLE === 'true'
  },
  security: {
    enableRateLimit: process.env.ENABLE_RATE_LIMIT !== 'false',
    enableCors: process.env.ENABLE_CORS !== 'false'
  }
};
