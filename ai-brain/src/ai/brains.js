const logger = require('../logs/logger.js');
const Intelligence = require('./intelligence.js');
const Learning = require('./learning.js');
const Simulation = require('./simulation.js');
const queries = require('../database/queries.js');

class Brain {
  constructor() {
    this.weights = { global: {}, coins: {} };
    this.config = { confidence_threshold: 0.7 };
    this.activeRecommendations = new Map();
  }

  async initialize() {
    try {
      logger.info('Initializing AI Brain...');
      await Intelligence.init(this);
      await this.loadWeights();
      logger.info('AI Brain ready');
    } catch (error) {
      logger.error('Failed to initialize Brain:', error);
    }
  }

  async loadWeights() {
    try {
      const dbWeights = await queries.getWeights();
      if (dbWeights) this.weights = dbWeights;
      const dbConfig = await queries.getConfig();
      if (dbConfig) this.config = dbConfig;
    } catch (error) {
      logger.warn('Could not load weights from DB, using defaults');
    }
  }

  async processMarketSnapshot(snapshot) {
    try {
      const { coin_id } = snapshot;
      const decision = await Intelligence.analyze(snapshot, this.weights, this.config);

      // 1. Aprender com o novo exemplo
      await Learning.processExample(snapshot, decision);

      // 2. Simular para histórico
      await Simulation.run(snapshot, decision);

      // 3. Se a decisão for relevante, manter na memória para o Executor buscar
      if (decision.decision !== 'not_enter') {
        this.activeRecommendations.set(coin_id, {
          coin_id,
          symbol: coin_id,
          decision: decision.decision.toUpperCase(),
          side: decision.side,
          confidence: decision.confidence,
          price: decision.price,
          stayReason: decision.stayReason, // REPASSANDO O MOTIVO
          timestamp: new Date()
        });
      }

      return decision;
    } catch (error) {
      logger.error('Error processing snapshot:', error);
    }
  }

  getRecommendations() {
    // Remove recomendações velhas (mais de 1 minuto)
    const now = new Date();
    for (const [id, rec] of this.activeRecommendations.entries()) {
      if (now - rec.timestamp > 60000) {
        this.activeRecommendations.delete(id);
      }
    }
    return Array.from(this.activeRecommendations.values());
  }

  getStatus() {
    return {
      recommendationsCount: this.activeRecommendations.size,
      threshold: this.config.confidence_threshold,
      mode: 'CONTINUOUS_LEARNING'
    };
  }
}

module.exports = new Brain();
