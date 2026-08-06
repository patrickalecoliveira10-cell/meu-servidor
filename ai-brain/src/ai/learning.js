const logger = require('../logs/logger.js');
const queries = require('../database/queries.js');

class Learning {
  constructor() {
    this.brain = null;
  }

  async init(brain) {
    this.brain = brain;
    logger.info('Learning module initialized');
  }

  async processExample(snapshot, decision) {
    try {
      // 1. Update Global Learning Counters
      await this.updateGlobalStats(decision);

      // 2. Update Coin Learning
      await this.updateCoinStats(snapshot.coin_id, decision);

      // 3. Pattern Discovery
      if (decision.confidence > 0.85) {
        await this.discoverPatterns(snapshot, decision);
      }

    } catch (error) {
      logger.error('Error in Learning process:', error);
    }
  }

  async updateGlobalStats(decision) {
    try {
      let stats = await queries.getGlobalLearning();
      if (!stats) {
        stats = { total_examples: 0, total_decisions: 0, correct_decisions: 0, win_rate: 0, avg_confidence: 0, patterns_learned: {} };
      }

      // Incremento manual garantindo que não seja nulo
      stats.total_examples = (parseInt(stats.total_examples) || 0) + 1;

      // avg_confidence é calculado sobre todos os exemplos processados
      stats.avg_confidence = (parseFloat(stats.avg_confidence || 0.5) * (stats.total_examples - 1) + decision.confidence) / stats.total_examples;

      // Log de progresso simplificado
      if (stats.total_examples % 20 === 0) {
        const winRateDisplay = stats.total_decisions > 0
          ? (parseFloat(stats.win_rate || 0) * 100).toFixed(2) + '%'
          : 'Waiting for first closed trade...';

        logger.info(`AI Progress: ${stats.total_examples}/1000 Examples. Closed Trades: ${stats.total_decisions} | Win Rate: ${winRateDisplay}`);
      }

      await queries.updateGlobalLearning(stats);
    } catch (e) {
      logger.error('Error updating global stats:', e);
    }
  }

  async updateCoinStats(coinId, decision) {
    try {
      let stats = await queries.getCoinLearning(coinId);
      if (!stats) {
        stats = { coin_id: coinId, total_examples: 1, total_decisions: 0, correct_decisions: 0, win_rate: 0, avg_confidence: decision.confidence, patterns_learned: {} };
      } else {
        stats.total_examples = (parseInt(stats.total_examples) || 0) + 1;
        // avg_confidence baseado no total de exemplos para esta moeda
        stats.avg_confidence = (parseFloat(stats.avg_confidence) * (stats.total_examples - 1) + decision.confidence) / stats.total_examples;
      }
      await queries.updateCoinLearning(stats);
    } catch (e) { /* ignore */ }
  }

  async discoverPatterns(snapshot, decision) {
    try {
      await queries.insertPattern({
        pattern_name: `High Confidence ${decision.decision} on ${snapshot.coin_id}`,
        coin_id: snapshot.coin_id,
        timeframe: snapshot.timeframe,
        pattern_type: decision.decision,
        success_rate: decision.win_probability,
        occurrence_count: 1,
        pattern_data: snapshot.indicators,
        last_seen: new Date()
      });
    } catch (e) { /* ignore */ }
  }

  async adjustWeights(indicatorName, success, coinId = null) {
    try {
      const learningRate = 0.02; // Aumentado para aprendizado mais rápido no início
      const currentWeights = await queries.getIndicatorWeights(coinId);
      let indicatorWeight = currentWeights.find(w => w.indicator_name === indicatorName);

      if (!indicatorWeight) {
        indicatorWeight = { indicator_name: indicatorName, coin_id: coinId, weight: 0.5, performance_score: 0.5 };
      }

      let newWeight = parseFloat(indicatorWeight.weight);
      let newScore = parseFloat(indicatorWeight.performance_score || 0.5);

      if (success) {
        newWeight += learningRate;
        newScore = Math.min(1, newScore + learningRate);
      } else {
        newWeight -= learningRate;
        newScore = Math.max(0, newScore - learningRate);
      }

      newWeight = Math.max(0.01, Math.min(1.0, newWeight));

      await queries.updateIndicatorWeight({
        ...indicatorWeight,
        weight: newWeight,
        performance_score: newScore
      });
    } catch (error) {
      logger.error('Error adjusting weights:', error);
    }
  }

  async adjustWeightsBasedOnResult(simulation, success) {
    try {
      const { decision_data, coin_id } = simulation;
      const indicators = decision_data.indicators_summary;

      if (!indicators) return;

      logger.info(`Learning from result: ${success ? 'WIN' : 'LOSS'} for ${coin_id}`);

      // ATUALIZAÇÃO DO WIN RATE GLOBAL (Baseado em Simulações Fechadas)
      let globalStats = await queries.getGlobalLearning();
      if (globalStats) {
        globalStats.total_decisions = (parseInt(globalStats.total_decisions) || 0) + 1;

        if (success) {
          globalStats.correct_decisions = (parseInt(globalStats.correct_decisions) || 0) + 1;
        }

        const wins = parseInt(globalStats.correct_decisions) || 0;
        const total = parseInt(globalStats.total_decisions) || 0;

        if (total > 0) {
          globalStats.win_rate = Math.min(1.0, wins / total);
        }

        await queries.updateGlobalLearning(globalStats);
      }

      // ATUALIZAÇÃO DO WIN RATE POR MOEDA
      let coinStats = await queries.getCoinLearning(coin_id);
      if (coinStats) {
        coinStats.total_decisions = (parseInt(coinStats.total_decisions) || 0) + 1;
        if (success) {
          coinStats.correct_decisions = (parseInt(coinStats.correct_decisions) || 0) + 1;
        }
        const cWins = parseInt(coinStats.correct_decisions) || 0;
        const cTotal = parseInt(coinStats.total_decisions) || 0;
        if (cTotal > 0) {
          coinStats.win_rate = Math.min(1.0, cWins / cTotal);
        }
        await queries.updateCoinLearning(coinStats);
      }

      // Itera sobre os indicadores usados na decisão para ajustar pesos
      for (const [name, data] of Object.entries(indicators)) {
        const signal = data.signal || 0;
        if (signal !== 0) {
          // Determina se o sinal foi na mesma direção do sucesso
          // Se winProbability > 0.5 foi um BUY. Se < 0.5 foi um SELL.
          const isBuy = decision_data.win_probability > 0.5;

          let helped = false;
          if (success) {
            // No lucro: indicadores que apontaram na direção certa ajudaram
            helped = (isBuy && signal > 0) || (!isBuy && signal < 0);
          } else {
            // No prejuízo: indicadores que apontaram na direção oposta ao erro "ajudaram" (tentaram evitar)
            helped = (isBuy && signal < 0) || (!isBuy && signal > 0);
          }

          await this.adjustWeights(name, helped, coin_id);
        }
      }

      await queries.insertLearningLog({
        log_type: 'weight_change',
        coin_id: coin_id,
        message: `Weights adjusted after ${success ? 'WIN' : 'LOSS'}`,
        data: { success },
        timestamp: new Date()
      });

    } catch (error) {
      logger.error('Error in adjustWeightsBasedOnResult:', error);
    }
  }
}

module.exports = Learning;
