const express = require('express');
const router = express.Router();
const scannerController = require('../controllers/scannerController');

// Scanner status and control
router.get('/status', scannerController.getStatus);
router.get('/scanner/status', scannerController.getStatus); // Para compatibilidade com App Android
router.post('/start', scannerController.startScanner);
router.post('/stop', scannerController.stopScanner);
router.post('/control', (req, res) => {
    const { action } = req.body;
    if (action === 'START') return scannerController.startScanner(req, res);
    if (action === 'STOP') return scannerController.stopScanner(req, res);
    if (action === 'RESTART') {
        marketScanner.stop().then(() => marketScanner.start());
        return res.json({ success: true, message: 'Scanner restarting' });
    }
    res.status(400).json({ success: false, error: 'Invalid action' });
});

// Data endpoints
router.get('/coins', scannerController.getCoins);
router.get('/results', scannerController.getResults);
router.get('/scanner/results', scannerController.getResults); // Para compatibilidade com App Android
router.get('/top', scannerController.getTopOpportunities);
router.get('/statistics', scannerController.getStatistics);

// Rotas de compatibilidade para App Android (no nível /api)
router.get('/api/status', scannerController.getStatus);
router.get('/api/results', scannerController.getResults);
router.post('/api/control', scannerController.stopScanner); // Fallback para controle
router.get('/api/scanner/status', scannerController.getStatus);
router.get('/api/scanner/results', scannerController.getResults);
router.post('/api/scanner/control', (req, res) => {
    const { action } = req.body;
    if (action === 'START') return scannerController.startScanner(req, res);
    if (action === 'STOP') return scannerController.stopScanner(req, res);
    res.status(400).json({ success: false, error: 'Invalid action' });
});

module.exports = router;
