const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const path = require('path');

// Log context for debugging on Render
console.log('--- Startup Environment ---');
console.log('CWD:', process.cwd());
console.log('Dirname:', __dirname);
console.log('---------------------------');

const config = require(path.join(__dirname, 'src/config/index.js'));
const logger = require(path.join(__dirname, 'src/logs/logger.js'));
const db = require(path.join(__dirname, 'src/database/connection.js'));
const routes = require(path.join(__dirname, 'src/routes/index.js'));
const Brain = require(path.join(__dirname, 'src/ai/brain.js'));

const app = express();

// Necessário para o Render identificar o IP real e não o do balanceador
app.set('trust proxy', 1);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(compression());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Request logging para debug no Render
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

app.use('/api', routes);

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    timestamp: new Date(),
    service: 'AI Brain V1.0',
    mode: Brain.getStatus().mode
  });
});

// Global Error Handler
app.use((err, req, res, next) => {
  if (logger && logger.error) {
    logger.error('Unhandled Error:', err);
  } else {
    console.error('Unhandled Error:', err);
  }
  res.status(500).json({ error: 'Internal Server Error', message: err.message });
});

const startServer = async () => {
  try {
    logger.info('Starting AI Brain V1.0...');

    // 1. Conexão com o banco (Neon compartilhado)
    await db.testConnection();

    // 2. Inicializar Schema se não existir
    if (db.initSchema) {
      await db.initSchema();
    }

    // 3. Inicialização do Cérebro
    await Brain.initialize();

    const PORT = process.env.PORT || 3002;
    app.listen(PORT, () => {
      logger.info(`AI Brain Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error('CRITICAL FAILURE DURING STARTUP:');
    console.error(error);
    process.exit(1);
  }
};

startServer();
