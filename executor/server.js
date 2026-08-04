require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const config = require('./src/config');
const logger = require('./src/logger');
const db = require('./src/database/connection');
const executorService = require('./src/services/executor');
const routes = require('./src/routes');

const app = express();
const PORT = process.env.PORT || 3003;

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(compression());
app.use(express.json());

// Log de Diagnóstico: Vamos ver exatamente o que chega
app.use((req, res, next) => {
  if (req.path !== '/api/executor/status') {
    logger.info(`Chamada Recebida: ${req.method} ${req.path}`);
  }
  next();
});

// 1. Rotas para o App Android (Prefixadas com /api/executor)
app.use('/api/executor', routes);

// 2. Rotas Diretas para a IA (Para evitar 404 independente de como ela chame)
app.post('/api/recommendations', async (req, res) => {
  try {
    const result = await executorService.processRecommendation(req.body);
    res.json({ success: true, data: result });
  } catch (error) {
    logger.error('Erro na rota direta /api/recommendations:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/manage', async (req, res) => {
  try {
    const result = await executorService.updatePositionManagement(req.body);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/', (req, res) => res.json({ status: 'online', service: 'Trade Executor', trade_limit: '1_per_time' }));

const start = async () => {
  try {
    await db.testConnection();
    await executorService.initialize();
    await executorService.start();
    app.listen(PORT, () => logger.info(`Executor Server rodando na porta ${PORT}`));
  } catch (err) {
    logger.error('Erro fatal no Executor:', err);
  }
};

start();
