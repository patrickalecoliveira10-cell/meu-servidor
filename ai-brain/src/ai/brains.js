const path = require('path');
const config = require(path.join(__dirname, '../config/index.js'));
const logger = require(path.join(__dirname, '../logs/logger.js'));
const queries = require(path.join(__dirname, '../database/queries.js'));
const apiClient = require(path.join(__dirname, '../utils/api-client.js'));
const Intelligence = require(path.join(__dirname, './intelligence.js'));
const Learning = require(path.join(__dirname, './learning.js'));
const Management = require(path.join(__dirname, './management.js'));
const Simulation = require(path.join(__dirname, './simulation.js'));

class Brain {
  constructor() {
    this.isInitialized = false;
    this.config = null;
    this.weights = {};
    this.stats = {};
    this.mode = 'observation';
    this.processingQueue = Promise.resolve(); // Fila para evitar processamento duplicado
  }

  async initialize() {
    try {
      logger.info('Initializing AI Brain core...');

      // 1. Load configuration from DB
      this.config = await queries.getConfiguration();
      if (!this.config) {
        logger.warn('No configuration found in DB, using defaults from file');
        this.config = {
          mode: config.ai.mode,
          min_examples_for_operation: config.ai.minExamplesForOperation,
          learning_rate: config.ai.learningRate,
          confidence_threshold: config.ai.confidenceThreshold,
          max_operations_per_day: config.ai.maxOperationsPerDay,
          current_examples_count: 0,
          is_operational: false
        };
      }
      this.mode = this.config.mode;

      // 2. Load Indicator Weights
      let weightsFromDb = await queries.getIndicatorWeights();
      if (weightsFromDb.length === 0) {
        logger.info('No weights found, seeding default weights...');
        await this.seedDefaultWeights();
        weightsFromDb = await queries.getIndicatorWeights();
      }
      this.weights = this.formatWeights(weightsFromDb);
      logger.info(`Loaded weights for ${Object.keys(this.weights.global || {}).length} global indicators`);

      // 3. Load Stats & Learning and sync counter
      this.stats.global = await queries.getGlobalLearning();
      const liveStats = await queries.getLiveStats();

      // Sincronização inteligente: usa o maior valor disponível entre Config, Global Stats e Simulações Reais
      const savedCount = Math.max(
        parseInt(this.config.current_examples_count || 0),
        parseInt(this.stats.global?.total_examples || 0),
        parseInt(liveStats.total_simulated_ops || 0)
      );

      if (savedCount > 0) {
        this.config.current_examples_count = savedCount;
        logger.info(`Synced examples count from DB: ${this.config.current_examples_count}`);

        // REPARAÇÃO DE ESTATÍSTICAS: Se temos simulações mas o win_rate global está zerado
        if (liveStats.total_simulated_ops > 0 && (!this.stats.global || this.stats.global.win_rate === 0)) {
           logger.info('Repairing global stats from historical simulations...');
           const repairedStats = {
             total_examples: savedCount,
             total_simulations: liveStats.total_simulated_ops,
             correct_decisions: liveStats.wins,
             win_rate: liveStats.calculatedWinRate,
             avg_confidence: 0.85,
             patterns_learned: this.stats.global?.patterns_learned || {}
           };
           await queries.updateGlobalLearning(repairedStats);
           this.stats.global = await queries.getGlobalLearning();
        }
      }

      // 4. Initialize Sub-modules
      await Intelligence.init(this);
      await Learning.init(this);
      await Management.init(this);
      await Simulation.init(this);

      this.isInitialized = true;
      logger.info(`AI Brain initialized in ${this.mode} mode`);

      // Check if we should switch to operational
      await this.checkOperationalStatus();

      // Iniciar loop de gerenciamento de posições abertas
      this.startManagementLoop();

    } catch (error) {
      logger.error('Error initializing AI Brain:', error);
      throw error;
    }
  }

  formatWeights(weightsArray) {
    const formatted = { global: {}, coins: {}, timeframes: {} };
    weightsArray.forEach(w => {
      if (!w.coin_id && !w.timeframe) {
        formatted.global[w.indicator_name] = parseFloat(w.weight);
      } else if (w.coin_id && !w.timeframe) {
        if (!formatted.coins[w.coin_id]) formatted.coins[w.coin_id] = {};
        formatted.coins[w.coin_id][w.indicator_name] = parseFloat(w.weight);
      }
    });

    // Garantir que indicadores básicos tenham peso se o global estiver vazio
    if (Object.keys(formatted.global).length === 0) {
      formatted.global = { rsi: 0.2, macd: 0.2, ema_cross: 0.2, bollinger: 0.2, volume: 0.2 };
    }

    return formatted;
  }

  async seedDefaultWeights() {
    const defaults = [
      { name: 'rsi', weight: 0.2 },
      { name: 'macd', weight: 0.2 },
      { name: 'ema_cross', weight: 0.2 },
      { name: 'bollinger', weight: 0.2 },
      { name: 'volume', weight: 0.2 }
    ];
    for (const d of defaults) {
      await queries.updateIndicatorWeight({
        indicator_name: d.name,
        weight: d.weight,
        performance_score: 0.5
      });
    }
  }

  async checkOperationalStatus() {
    if (this.mode === 'observation' &&
        this.config.current_examples_count >= this.config.min_examples_for_operation) {
      logger.info('Minimum examples reached. Switching to OPERATIONAL mode!');
      this.mode = 'operational';
      this.config.mode = 'operational';
      this.config.is_operational = true;
      await queries.updateConfiguration(this.config);
    }
  }

  async processMarketSnapshot(snapshot) {
    if (!this.isInitialized) return;

    // Enfileira o processamento para evitar condições de corrida (fechamento duplo de ordens)
    return this.processingQueue = this.processingQueue.then(async () => {
      try {
        logger.debug(`Processing snapshot for ${snapshot.coin_id} ${snapshot.timeframe}`);

        // 1. Calculate Decision
        const decision = await Intelligence.analyze(snapshot, this.weights, this.config);

        // 2. Save decision to DB
        await queries.insertDecision(decision);

        // 3. Learning (Continuous)
        await Learning.processExample(snapshot, decision);

        // 4. Simulation (Always run for learning)
        await Simulation.run(snapshot, decision);

        // 5. If Operational and "Enter", notify Executor
        if (this.mode === 'operational' && decision.decision === 'enter') {
          logger.info(`AI recommends ENTRY for ${snapshot.coin_id}: Confidence ${decision.confidence}`);
          await apiClient.sendRecommendation(decision);
        }

        // 6. Update stats counter
        this.config.current_examples_count++;

        // Log de progresso explícito para monitoramento da meta de 1000
        if (this.config.current_examples_count % 10 === 0) {
          logger.info(`AI Progress: ${this.config.current_examples_count}/${this.config.min_examples_for_operation || 1000} examples analyzed.`);
        }

        // Persistir progresso no banco a cada 10 exemplos (mais frequente para evitar perdas no Render)
        if (this.config.current_examples_count % 10 === 0) {
          await queries.updateConfiguration(this.config);
          await this.checkOperationalStatus();
        }

        return decision;
      } catch (error) {
        logger.error('Error processing market snapshot:', error);
      }
    });
  }

  async updateOperation(operationData) {
    // Called by Executor or Scanner to update current open positions
    return await Management.reevaluate(operationData, this.weights, this.config);
  }

  async startManagementLoop() {
    logger.info('Starting AI Management loop...');
    setInterval(async () => {
      try {
        if (!this.isInitialized) return;

        // 1. Obter posições abertas reais via Executor
        const response = await apiClient.getOpenPositions();
        if (response && response.success && response.data && response.data.openOperations) {
          const positions = response.data.openOperations;

          for (const pos of positions) {
            // Re-avaliar cada posição aberta
            // Nota: Precisamos dos indicadores atuais da moeda para re-avaliar
            // Vamos buscar o último snapshot do banco para essa moeda
            const latestSnapshot = await queries.getLatestSnapshot(pos.symbol);

            await Management.reevaluate({
              ...pos,
              coin_id: pos.symbol,
              current_price: pos.currentPrice,
              entry_price: pos.entryPrice,
              indicators: latestSnapshot?.indicators || {} // Fallback para objeto vazio se não houver snapshot
            }, this.weights, this.config);
          }
        }
      } catch (error) {
        logger.error('Error in management loop:', error.message);
      }
    }, 15000); // Check every 15 seconds
  }

  getStatus() {
    return {
      mode: this.mode,
      initialized: this.isInitialized,
      examples: this.config?.current_examples_count || 0,
      minExamples: this.config?.min_examples_for_operation || 1000,
      isOperational: this.mode === 'operational',
      uptime: Math.floor(process.uptime())
    };
  }
}

module.exports = new Brain();
