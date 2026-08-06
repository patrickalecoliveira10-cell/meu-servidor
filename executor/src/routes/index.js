const express = require('express');
const router = express.Router();
const executorService = require('../services/executor');
// Caminho corrigido para o logger central
const logger = require('../../../ai-brain/src/logs/logger');

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
    const allPositions = await bybitService.getPosition() || [];
    
    // Filtrar apenas posições reais (tamanho > 0)
    const activePositions = allPositions.filter(p => parseFloat(p.size || 0) > 0);

    const mappedOperations = activePositions.map(p => ({
      id: p.symbol, // ID ESTÁVEL: Apenas o símbolo
      symbol: p.symbol,
      side: p.side,
      entryPrice: parseFloat(p.avgPrice || 0),
      currentPrice: parseFloat(p.markPrice || 0),
      currentStop: parseFloat(p.stopLoss || 0),
      currentTrailing: parseFloat(p.trailingStop || 0), // Pegando o trailing atual
      currentProfit: parseFloat(p.unrealisedPnl || 0),
      roi: p.positionValue > 0 ? (parseFloat(p.unrealisedPnl) / parseFloat(p.positionValue)) * 100 : 0,
      entryReason: "AI Signal Strength: " + (p.leverage || "1x"),
      stayReason: executorService.lastReasons[p.symbol] || "IA monitorando tendências de mercado...", // Texto humano
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

// NOVO: Receber recomendações do AI Brain
router.post('/recommendations', async (req, res) => {
  try {
    const decision = req.body;
    logger.info(`Recommendation received for ${decision.coin_id}: ${decision.decision}`);

    // Encaminha para o serviço de execução
    const result = await executorService.processRecommendation(decision);

    sendResponse(res, true, result, "Recommendation processed");
  } catch (error) {
    logger.error('Error processing recommendation:', error);
    sendResponse(res, false, null, error.message, 500);
  }
});

// POST /manage - Receber sinais de gerenciamento (AI)
router.post('/manage', async (req, res) => {
  try {
    const signal = req.body;
    const result = await executorService.updatePositionManagement(signal);
    sendResponse(res, true, result, "Management signal processed");
  } catch (error) {
    logger.error('Error processing management signal:', error);
    sendResponse(res, false, null, error.message, 500);
  }
});

// NOVO: Ação genérica do App Android (Mapeia para fechar)
router.post('/action', async (req, res) => {
  try {
    const { action, symbol } = req.body;
    logger.info(`[ANDROID_ACTION] ${action} solicitado para ${symbol}`);

    // GARANTE QUE USA A INSTÂNCIA VIVA DO SUPER SERVIDOR
    const activeExecutor = global.liveExecutorService || executorService;

    if (action === 'CLOSE') {
      const result = await activeExecutor.updatePositionManagement({
        coin_id: symbol,
        decision: 'close'
      });
      return sendResponse(res, true, result, `Position ${symbol} closed`);
    }

    sendResponse(res, true, null, "Action received");
  } catch (error) {
    logger.error('Error in android action:', error);
    sendResponse(res, false, null, error.message, 500);
  }
});

// NOVO: Botão de Emergência do App
router.post('/emergency', async (req, res) => {
  try {
    logger.warn('[EMERGENCY] Modo de emergência acionado!');
    // Fecha tudo
    const bybit = require('../services/bybit');
    const positions = await bybit.getPosition();
    for (const p of positions) {
       if (parseFloat(p.size) > 0) {
         await executorService.updatePositionManagement({ coin_id: p.symbol, decision: 'close' });
       }
    }
    sendResponse(res, true, null, "All positions closed (Emergency)");
  } catch (error) {
    sendResponse(res, false, null, error.message, 500);
  }
});

module.exports = router;
