const marketScanner = require('../scanner/marketScanner');
const queries = require('../database/queries');
const logger = require('../logs/logger');

// Função auxiliar para padronizar respostas e evitar crashes no Android
const sendResponse = (res, success, data = null, message = null, statusCode = 200) => {
  res.status(statusCode).json({
    success: success,
    data: data,
    message: message || (success ? 'Operation successful' : 'Operation failed'),
    timestamp: Date.now() // ESSENCIAL para o Kotlin
  });
};

class ScannerController {
  // Get scanner status
  async getStatus(req, res) {
    try {
      const status = marketScanner.getStatus();
      const mem = process.memoryUsage();

      // ESTRUTURA EXATA PARA ServerInfo.kt
      sendResponse(res, true, {
        type: "SCANNER",
        status: status.isRunning ? "ONLINE" : "OFFLINE",
        uptime: Math.floor(process.uptime()),
        cpuUsage: 0.0,
        memoryUsage: Math.round(mem.heapUsed / 1024 / 1024 * 100) / 100,
        latency: 0,
        lastSync: Date.now(),
        version: "1.0.0",
        errorCount: status.stats?.errorsCount || 0,
        url: "https://trickpps2-scanner-1.onrender.com"
      });
    } catch (error) {
      logger.error('Error getting scanner status:', error);
      sendResponse(res, false, null, error.message, 500);
    }
  }

  // Start scanner
  async startScanner(req, res) {
    try {
      await marketScanner.start();
      sendResponse(res, true, null, 'Scanner started successfully');
    } catch (error) {
      logger.error('Error starting scanner:', error);
      sendResponse(res, false, null, error.message, 500);
    }
  }

  // Stop scanner
  async stopScanner(req, res) {
    try {
      await marketScanner.stop();
      sendResponse(res, true, null, 'Scanner stopped successfully');
    } catch (error) {
      logger.error('Error stopping scanner:', error);
      sendResponse(res, false, null, error.message, 500);
    }
  }

  // Get coins
  async getCoins(req, res) {
    try {
      const limit = parseInt(req.query.limit) || 100;
      const coins = await queries.getCoins(limit);
      sendResponse(res, true, Array.isArray(coins) ? coins : []);
    } catch (error) {
      logger.error('Error getting coins:', error);
      sendResponse(res, false, [], error.message, 500);
    }
  }

  // Get scanner results (Principal fonte de dados do App)
  async getResults(req, res) {
    try {
      const limit = parseInt(req.query.limit) || 50;
      const results = await queries.getRecentResults(limit);
      const status = marketScanner.getStatus();
      const safeResults = Array.isArray(results) ? results : [];

      // Mapeamento para o formato CoinOpportunity.kt do Android
      const mappedOpportunities = safeResults.map(r => {
        // Tenta pegar os indicadores da coluna correta do banco
        const indicatorsData = r.indicators_matched || r.indicators_summary || {};
        const indicatorList = indicatorsData.indicators ? Object.keys(indicatorsData.indicators) : [];

        return {
          symbol: r.symbol || 'UNKNOWN',
          probability: parseFloat(r.score || 0) / 100,
          confidence: parseFloat(r.score || 0) / 100,
          indicators: indicatorList,
          timeframe: r.timeframe || '15m',
          timestamp: new Date(r.timestamp).getTime()
        };
      });

      // ESTRUTURA RIGOROSA PARA O ANDROID (ScannerData.kt)
      sendResponse(res, true, {
        metrics: {
          monitoredCoins: status.stats?.totalCoins || 100,
          approvedCoins: mappedOpportunities.length,
          rejectedCoins: 0,
          lastAnalysisTime: Date.now(),
          monitoredTimeframes: 4,
          scanSpeed: status.stats?.scanTime || 1.5,
          snapshotsSent: status.stats?.snapshotsCreated || 0
        },
        topCoins: mappedOpportunities.slice(0, 10),
        bestOpportunities: mappedOpportunities
      });
    } catch (error) {
      logger.error('Error getting scanner results:', error);
      sendResponse(res, false, { metrics: {}, topCoins: [], bestOpportunities: [] }, error.message, 500);
    }
  }

  // Get top opportunities
  async getTopOpportunities(req, res) {
    try {
      const limit = parseInt(req.query.limit) || 20;
      const minScore = parseInt(req.query.minScore) || 70;
      const opportunities = await queries.getTopOpportunities(limit, minScore);
      sendResponse(res, true, Array.isArray(opportunities) ? opportunities : []);
    } catch (error) {
      logger.error('Error getting top opportunities:', error);
      sendResponse(res, false, [], error.message, 500);
    }
  }

  // Get scanner statistics
  async getStatistics(req, res) {
    try {
      const stats = await queries.getScannerStatistics();
      const scannerStatus = marketScanner.getStatus();
      
      sendResponse(res, true, {
        database: stats || {},
        runtime: scannerStatus.stats || {}
      });
    } catch (error) {
      logger.error('Error getting scanner statistics:', error);
      sendResponse(res, false, null, error.message, 500);
    }
  }
}

module.exports = new ScannerController();
