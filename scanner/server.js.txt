require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const config = require('./src/config');
const logger = require('./src/logs/logger');
const db = require('./src/database/connection');
const bybitService = require('./src/services/bybit');
const marketScanner = require('./src/scanner/marketScanner');

const app = express();
// Priorizar a porta fornecida pelo Render (process.env.PORT)
const PORT = process.env.PORT || config.server.port || 3001;

// Ativar confiança no proxy do Render/Cloudflare para o rate-limit funcionar
app.set('trust proxy', 1);

// Middleware
app.use(helmet());
app.use(cors({
  origin: config.cors.origin,
  credentials: true
}));
app.use(compression());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const limiter = rateLimit({
  windowMs: config.rateLimit.window * 60 * 1000,
  max: config.rateLimit.maxRequests,
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// Request logging
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`, {
    ip: req.ip,
    userAgent: req.get('user-agent')
  });
  next();
});

// Routes
app.get('/', (req, res) => {
  res.json({
    name: 'Market Scanner V1.0',
    version: '1.0.0',
    description: 'Servidor de monitoramento de mercado para IA Trading Criptomoedas',
    status: 'running',
    endpoints: {
      health: '/api/health',
      status: '/api/scanner/status',
      start: '/api/scanner/start',
      stop: '/api/scanner/stop',
      coins: '/api/scanner/coins',
      results: '/api/scanner/results',
      top: '/api/scanner/top',
      statistics: '/api/scanner/statistics'
    }
  });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    memory: process.memoryUsage(),
    scanner: marketScanner.getStatus()
  });
});

// API Routes
app.use('/api/scanner', require('./src/routes/scanner'));

// Rotas de compatibilidade diretas para App Android (sem redirect, chamando controller direto)
const scannerController = require('./src/controllers/scannerController');
app.get('/api/status', (req, res) => scannerController.getStatus(req, res));
app.get('/api/results', (req, res) => scannerController.getResults(req, res));

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error('Error:', err);
  res.status(500).json({
    success: false,
    error: err.message,
    stack: config.server.env === 'development' ? err.stack : undefined
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Route not found'
  });
});

// Graceful shutdown
const gracefulShutdown = async (signal) => {
  logger.info(`${signal} received. Starting graceful shutdown...`);
  
  // Stop scanner
  await marketScanner.stop();
  
  // Close database connection
  await db.close();
  
  logger.info('Graceful shutdown completed');
  process.exit(0);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Unhandled errors
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  gracefulShutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Initialization
const initialize = async () => {
  try {
    logger.info('Starting Market Scanner V1.0...');
    logger.info(`Environment: ${config.server.env}`);
    logger.info(`Port: ${PORT}`);
    
    // Test database connection
    logger.info('Testing database connection...');
    const dbConnected = await db.testConnection();
    if (!dbConnected) {
      throw new Error('Failed to connect to database');
    }
    
    // Check tables
    await db.checkTables();
    
    // Check database size and cleanup if needed
    await db.checkSizeAndCleanup();
    
    // Schedule automatic cleanup every 24 hours
    setInterval(async () => {
      await db.checkSizeAndCleanup();
    }, 24 * 60 * 60 * 1000);
    
    // Test Bybit connection
    logger.info('Testing Bybit API connection...');
    try {
      const bybitConnected = await bybitService.testConnection();
      if (!bybitConnected) {
        logger.warn('Failed to connect to Bybit API. Will retry during scanning.');
      }
    } catch (bybitErr) {
      logger.warn('Bybit connection test failed, but continuing... error: ' + bybitErr.message);
    }
    
    // Start server
    app.listen(PORT, () => {
      logger.info(`Server running on port ${PORT}`);
      logger.info(`API available at http://localhost:${PORT}`);
    });
    
    // Auto-start scanner
    logger.info('Auto-starting scanner...');
    setTimeout(() => {
      marketScanner.start().catch(error => {
        logger.error('Failed to auto-start scanner:', error);
      });
    }, 5000);
    
  } catch (error) {
    logger.error('Failed to initialize server:', error);
    process.exit(1);
  }
};

// Start the server
initialize();

module.exports = { app, db };
