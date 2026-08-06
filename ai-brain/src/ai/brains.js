const logger = require('../logs/logger.js');
const queries = require('../database/queries.js');

class Brain {
  constructor() {
    this.weights = {
      global: {
        'RSI': 1.0, 'MACD': 1.0, 'ADX': 0.8,
        'EMA': 0.9, 'BOLLINGER': 0.7, 'SUPERTREND': 0.85,
        'VWAP': 0.75, 'STOCHASTIC': 0.6, 'ICHIMOKU': 0.8,
        'HEIKEN_ASHI': 0.65, 'OBV': 0.6
      },
      coins: {}
    };
    this.config = { confidence_threshold: 0.68 };
    this.activeRecommendations = new Map();
    this.intelligence = null;
    this.learning = null;
    this.simulation = null;
  }

  async initialize() {
    try {
      logger.info('Initializing AI Brain...');

      // Lazy load to break circular dependencies
      const intelModule = require('./intelligence.js');
      const learningModule = require('./learning.js');
      const simulationModule = require('./simulation.js');

      // Defensive assignment (handles class or potential partially loaded instance)
      const resolveModule = (mod) => {
        if (typeof mod === 'function') return new mod();
        if (mod && mod.init) return mod;
        return null;
      };

      this.intelligence = resolveModule(intelModule);
      this.learning = resolveModule(learningModule);
      this.simulation = resolveModule(simulationModule);

      if (!this.intelligence || !this.learning || !this.simulation) {
          throw new Error(`One or more modules failed to load correctly: Intel(${!!this.intelligence}), Learn(${!!this.learning}), Sim(${!!this.simulation})`);
      }

      // Initialize sub-modules with brain reference
      if (this.intelligence.init) await this.intelligence.init(this);
      if (this.learning.init) await this.learning.init(this);
      if (this.simulation.init) await this.simulation.init(this);

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
      if (this.intelligence.stats && decision.decision === 'enter') {
        this.intelligence.stats.total_simulated_ops++;
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
