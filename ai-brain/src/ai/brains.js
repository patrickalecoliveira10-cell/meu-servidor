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

      // 3. Manter na memória para o Executor buscar (sempre atualiza o stayReason)
      this.activeRecommendations.set(coin_id, {
        coin_id,
        symbol: coin_id,
        decision: decision.decision.toUpperCase(),
        side: decision.side,
        confidence: decision.confidence,
        price: decision.price,
        stayReason: decision.stayReason,
        timestamp: new Date()
      });

      logger.info(`[BRAIN] Analysis for ${coin_id}: ${decision.stayReason}`);

      return decision;
    } catch (error) {
      logger.error('Error processing snapshot:', error);
    }
  }

  getRecommendations() {
    // Aumentado para 5 minutos para garantir sincronia com o App
    const now = new Date();
    for (const [id, rec] of this.activeRecommendations.entries()) {
      if (now - rec.timestamp > 300000) {
        this.activeRecommendations.delete(id);
      }
    }
    return Array.from(this.activeRecommendations.values());
  }

  getStatus() {
    return {
      recommendationsCount: this.activeRecommendations.size,
      threshold: this.config.confidence_threshold,
      mode: 'CONTINUOUS_LEARNING',
      initialized: true,
      current_examples_count: Intelligence.stats ? Intelligence.stats.total_snapshots : 0,
      examples: Intelligence.stats ? Intelligence.stats.total_snapshots : 0,
      total_simulated_ops: Intelligence.stats ? Intelligence.stats.total_simulated_ops : 0
    };
  }
}

module.exports = new Brain();
