const logger = require('../logs/logger.js');
const queries = require('../database/queries.js');

class Brain {
  constructor() {
    this.weights = {
      global: {
        'RSI': 1.0, 'MACD': 1.0, 'ADX': 0.8,
        'EMA': 0.9, 'BOLLINGER': 0.7, 'SUPERTREND': 0.85,
        'VWAP': 0.75, 'STOCHASTIC': 0.6, 'PSAR': 0.7,
        'HEIKEN_ASHI': 0.65, 'OBV': 0.6
      },
      coins: {}
    };
    this.config = { confidence_threshold: 0.60 };
    this.activeRecommendations = new Map();
    this.intelligence = null;
    this.learning = null;
    this.simulation = null;
  }

  async initialize() {
    try {
      logger.info('Initializing AI Brain...');

      // Lazy load to break circular dependencies
      const Intelligence = require('./intelligence.js');
      const Learning = require('./learning.js');
      const Simulation = require('./simulation.js');

      // Instantiate modules directly
      this.intelligence = new Intelligence();
      this.learning = new Learning();
      this.simulation = new Simulation();

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
      
      // Defensive check - ensure intelligence is initialized
      if (!this.intelligence || typeof this.intelligence.analyze !== 'function') {
        logger.error('[BRAIN] Intelligence module not properly initialized');
        return null;
      }
      
      const decision = await this.intelligence.analyze(snapshot, this.weights, this.config);

      // 1. Aprender com o novo exemplo
      await this.learning.processExample(snapshot, decision);

      // 2. Simular para histórico se a confiança for mínima para aprendizado
      // Aumentamos para 0.60 para evitar aprender com "ruído"
      if (decision.confidence >= 0.60) {
        await this.simulation.run(snapshot, decision);
      }

      // Incrementar contador local para atualização imediata no App
      if (this.intelligence.stats && decision.decision === 'enter') {
        this.intelligence.stats.total_simulated_ops++;
      }
      // Só sobrescreve se o novo sinal for ENTER, ou se não houver sinal ENTER ativo nos últimos 60s
      const existing = this.activeRecommendations.get(coin_id);
      const now = new Date();
      const isExistingEnterFresh = existing &&
        existing.decision === 'ENTER' &&
        (now - existing.timestamp) < 60000;

      if (!isExistingEnterFresh || decision.decision === 'enter') {
        this.activeRecommendations.set(coin_id, {
          coin_id,
          symbol: coin_id,
          decision: decision.decision.toUpperCase(),
          side: decision.side,
          confidence: decision.confidence,
          price: decision.price,
          stayReason: decision.stayReason,
          timestamp: now
        });
      }

      logger.info(`[BRAIN] Analysis for ${coin_id}: ${decision.stayReason} Confidence: ${Math.round(decision.confidence * 100)}%`);

      return decision;
    } catch (error) {
      logger.error('Error processing snapshot:', error);
    }
  }

  getRecommendations() {
    const now = new Date();
    // Retenção de 5 minutos para garantir que o App sempre tenha dados
    for (const [id, rec] of this.activeRecommendations.entries()) {
      if (now - rec.timestamp > 300000) {
        this.activeRecommendations.delete(id);
      }
    }
    const recommendations = Array.from(this.activeRecommendations.values());
    
    // Debug: Log primeiras 5 recomendações para verificar formato
    if (recommendations.length > 0) {
      const sample = recommendations.slice(0, 5).map(r => ({
        coin_id: r.coin_id,
        decision: r.decision,
        confidence: r.confidence,
        side: r.side
      }));
      console.log('[BRAIN-DEBUG] Sample recommendations:', JSON.stringify(sample));
    }
    
    return recommendations;
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
