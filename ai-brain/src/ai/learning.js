const logger = require('../logs/logger.js');
const queries = require('../database/queries.js');

class Learning {
  async processExample(snapshot, decision) {
    try {
      // 1. Salva a decisão no banco primeiro
      await queries.insertDecision(decision);

      // 2. Atualiza estatísticas globais
      let stats = await queries.getGlobalLearning();
      if (!stats) {
        stats = { total_examples: 0, total_decisions: 0, win_rate: 0, avg_confidence: 0 };
      }

      stats.total_examples = (parseInt(stats.total_examples) || 0) + 1;
      stats.avg_confidence = ((parseFloat(stats.avg_confidence) || 0.5) * (stats.total_examples - 1) + decision.confidence) / stats.total_examples;

      await queries.updateGlobalLearning(stats);

    } catch (error) {
      logger.error('Error in Learning process:', error.message);
    }
  }
}

module.exports = new Learning();
