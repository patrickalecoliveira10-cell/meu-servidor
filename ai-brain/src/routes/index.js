const express = require('express');
const router = express.Router();
const path = require('path');
const AIController = require('../controllers/aicontroller.js');

// Rotas para o App Android (Compatibilidade Total)
router.get('/data', (req, res) => AIController.getAIDataForApp(req, res));
router.get('/ai/data', (req, res) => AIController.getAIDataForApp(req, res));
router.get('/ai/statistics', (req, res) => AIController.getStatisticsData(req, res));
router.get('/ai/database', (req, res) => AIController.getDatabaseData(req, res));

// Controle e Status (Resolvendo os 404 do log)
router.get('/status', (req, res) => AIController.getStatus(req, res));
router.get('/health', (req, res) => AIController.getHealth(req, res));
router.get('/ai/active-trade', (req, res) => AIController.getActiveTrade(req, res));
router.post('/ai/control', (req, res) => AIController.controlStatus(req, res));
router.post('/ai/reset', (req, res) => AIController.resetDatabase(req, res));
router.get('/ai/status/control', (req, res) => AIController.controlStatus(req, res));
router.get('/status/control', (req, res) => AIController.controlStatus(req, res));
router.post('/status/control', (req, res) => AIController.controlStatus(req, res));
router.get('/executor/control', (req, res) => AIController.controlStatus(req, res)); // Redundância solicitada pelo App

// Data Reception (Scanner) e Recomendações (Executor)
router.post('/snapshot', (req, res) => AIController.receiveSnapshot(req, res));
router.get('/recommendations', (req, res) => AIController.getRecommendations(req, res));

module.exports = router;
