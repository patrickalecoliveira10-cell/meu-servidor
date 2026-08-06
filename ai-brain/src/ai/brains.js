const logger = require('../logs/logger.js');
const queries = require('../database/queries.js');

class Brain {
  constructor() {
    this.weights = { global: { 'RSI': 1.0, 'MACD': 1.0, 'ADX': 0.8 }, coins: {} };
    this.config = { confidence_threshold: 0.7 };
    this.activeRecommendations = new Map();
    this.intelligence = null;
    this.learning = null;
    this.simulation = null;
  }

  async initialize() {
    try {
      logger.info('Initializing AI Brain...');

      // Lazy load to break circular dependencies
      this.intelligence = require('./intelligence.js');
      this.learning = require('./learning.js');
      this.simulation = require('./simulation.js');

      // Initialize sub-modules with brain reference
      await this.intelligence.init(this);
      await this.learning.init(this);
      await this.simulation.init(this);

      await this.loadWeights();
      logger.info('AI Brain ready');
    } catch (error) {
      logger.error('Failed to initialize Brain:', error);
    }
  }

  async loadWeights() {
    try {
      const dbWeights = await queries.getIndicatorWeights();
      if (dbWeights && dbWeights.length > 0) {
        // Map weights to the internal structure if needed
        dbWeights.forEach(w => {
          this.weights.global[w.indicator_name] = w.weight;
        });
      }
      const dbConfig = await queries.getConfiguration();
      if (dbConfig) this.config = dbConfig;
    } catch (error) {
      logger.warn('Could not load weights from DB, using defaults');
    }
  }

  async processMarketSnapshot(snapshot) {
    try {
      const { coin_id } = snapshot;
      const decision = await this.intelligence.analyze(snapshot, this.weights, this.config);

      // 1. Aprender com o novo exemplo
      await this.learning.processExample(snapshot, decision);

      // 2. Simular para histórico
      await this.simulation.run(snapshot, decision);

      // Incrementar contador local para atualização imediata no App
      if (this.intelligence.stats) {
        this.intelligence.stats.total_snapshots++;
        if (decision.decision === 'enter') {
          this.intelligence.stats.total_simulated_ops++;
        }
      }
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

      logger.info(`[BRAIN] Analysis for ${coin_id}: ${decision.stayReason} Confidence: ${Math.round(decision.confidence * 100)}%`);

      return decision;
    } catch (error) {
      logger.error('Error processing snapshot:', error);
    }
  }

  getRecommendations() {
    // Retenção de 5 minutos para garantir que o App sempre tenha dados
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
      threshold: this.config.threshold || this.config.confidence_threshold,
      mode: 'CONTINUOUS_LEARNING',
      initialized: true,
      current_examples_count: this.intelligence?.stats ? this.intelligence.stats.total_snapshots : 0,
      examples: this.intelligence?.stats ? this.intelligence.stats.total_snapshots : 0,
      total_simulated_ops: this.intelligence?.stats ? this.intelligence.stats.total_simulated_ops : 0
    };
  }
}

module.exports = new Brain();
