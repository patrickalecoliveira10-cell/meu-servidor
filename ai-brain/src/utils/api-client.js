const axios = require('axios');
const path = require('path');
const config = require(path.join(__dirname, '../config/index.js'));
const logger = require(path.join(__dirname, '../logs/logger.js'));

class APIClient {
  constructor() {
    const isUnified = process.env.UNIFIED_MODE === 'true';
    const port = process.env.PORT || 10000;
    this.executorUrl = isUnified ? `http://localhost:${port}` : 'https://trickapps2.onrender.com';
  }

  async sendRecommendation(decision) {
    try {
      const url = `${this.executorUrl}/api/recommendations`;
      const response = await axios.post(url, decision, { timeout: 10000 });
      return response.data;
    } catch (error) {
      return null;
    }
  }

  async getOpenPositions() {
    try {
      const url = `${this.executorUrl}/api/executor/positions`;
      const response = await axios.get(url, { timeout: 5000 });
      return response.data;
    } catch (error) {
      return null;
    }
  }
}
const apiClient = new APIClient();
module.exports = apiClient;
