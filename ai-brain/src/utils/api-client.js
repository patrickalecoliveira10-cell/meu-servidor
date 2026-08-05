const axios = require('axios');
const path = require('path');
const config = require(path.join(__dirname, '../config/index.js'));
const logger = require(path.join(__dirname, '../logs/logger.js'));

class APIClient {
  constructor() {
    // Se estiver rodando unificado, usa localhost para não gastar banda de internet
    const isUnified = process.env.UNIFIED_MODE === 'true';
    const port = process.env.PORT || 10000;

    this.executorUrl = isUnified ? `http://localhost:${port}` : 'https://trickapps2.onrender.com';
    this.scannerUrl = config.scanner.apiUrl;
  }

  async sendRecommendation(decision) {
    try {
      // Ajustado para a rota correta do Executor no Super Servidor
      const url = `${this.executorUrl}/api/executor/recommendations`;
      logger.info(`[AI Brain] Enviando recomendação para: ${url} | Moeda: ${decision.coin_id}`);

      const response = await axios.post(url, decision, { timeout: 10000 });
      return response.data;
    } catch (error) {
      logger.error(`[AI Brain] Falha na comunicação com Executor: ${error.message}`);
      return null;
    }
  }

  async sendManagementSignal(signal) {
    try {
      // Ajustado para a rota correta do Executor no Super Servidor
      const url = `${this.executorUrl}/api/executor/manage`;
      const response = await axios.post(url, signal, { timeout: 10000 });
      return response.data;
    } catch (error) {
      logger.error(`[AI Brain] Falha no sinal de gestão: ${error.message}`);
      return null;
    }
  }

  async getOpenPositions() {
    try {
      // Endpoint correto no Executor para listar posições
      const url = `${this.executorUrl}/api/executor/positions`;
      const response = await axios.get(url, { timeout: 5000 });

      // Axios retorna o corpo da resposta em .data
      // O nosso Executor retorna { success: true, data: { openOperations: [...] } }
      return response.data;
    } catch (error) {
      logger.debug(`[AI Brain] Falha ao buscar posições do Executor: ${error.message}`);
      return null;
    }
  }
}

const apiClient = new APIClient();
module.exports = apiClient;
