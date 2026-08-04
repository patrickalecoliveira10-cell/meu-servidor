const express = require('express');
const router = express.Router();
const executorService = require('../services/executor');
const logger = require('../logger');

// Função auxiliar para garantir que o Android receba exatamente o que espera
const sendResponse = (res, success, data = null, message = null, statusCode = 200) => {
  res.status(statusCode).json({
    success: success,
    data: data,
    message: message || (success ? 'Operation successful' : 'Operation failed'),
    timestamp: Date.now() // OBRIGATÓRIO
  });
};

// GET /status - Mapeado para ServerInfo.kt
router.get('/status', (req, res) => {
  try {
    const status = executorService.getStatus();
    const mem = process.memoryUsage();

    sendResponse(res, true, {
      type: "EXECUTOR",
      status: status.isRunning ? "ONLINE" : "OFFLINE",
      uptime: status.uptime,
      cpuUsage: 0.0,
      memoryUsage: Math.round(mem.heapUsed / 1024 / 1024 * 100) / 100,
      latency: 0,
      lastSync: Date.now(),
      version: "1.0.0",
      errorCount: 0,
      url: "https://trickapps2.onrender.com"
    });
  } catch (error) {
    logger.error('Error getting status:', error);
    sendResponse(res, false, null, error.message, 500);
  }
});

// GET /positions - Mapeado para ExecutorData.kt e Operation.kt
router.get('/positions', async (req, res) => {
  try {
    const bybitService = require('../services/bybit');
    const positions = await bybitService.getPosition() || [];
    
    const mappedOperations = positions.map(p => ({
      id: p.symbol + p.updatedTime,
      symbol: p.symbol,
      entryPrice: parseFloat(p.avgPrice || 0),
      currentProfit: parseFloat(p.unrealisedPnl || 0),
      roi: p.positionValue > 0 ? (parseFloat(p.unrealisedPnl) / parseFloat(p.positionValue)) * 100 : 0,
      entryReason: "AI Signal Strength: " + (p.leverage || "1x"),
      isOpen: true,
      timestamp: parseInt(p.createdTime || Date.now())
    }));

    sendResponse(res, true, {
      openOperations: mappedOperations,
      paused: executorService.isPaused || false,
      mode: "AUTO"
    });
  } catch (error) {
    logger.error('Error getting positions:', error);
    sendResponse(res, false, { openOperations: [], paused: false, mode: "AUTO" }, error.message, 500);
  }
});

// POST /control - Controle de Start/Stop
router.post('/control', (req, res) => {
  try {
    const { action } = req.body;
    if (action === 'START') executorService.isPaused = false;
    if (action === 'STOP') executorService.isPaused = true;
    
    sendResponse(res, true, null, `Executor ${action} successful`);
  } catch (error) {
    sendResponse(res, false, null, error.message, 500);
  }
});

module.exports = router;
