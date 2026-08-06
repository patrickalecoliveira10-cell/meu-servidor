const logger = require('../logs/logger.js');
const queries = require('../database/queries.js');class Simulation {
  constructor() { this.brain = null; }

  async init(brain) {
    this.brain = brain;
    logger.info('Simulation module initialized');
  }

  async run(snapshot, decision) {
    try {
      await this.updateResults(snapshot);
      if (decision.decision !== 'enter') return;

      const price = parseFloat(snapshot.close || snapshot.price || 0);
      if (price <= 0) return;

      const simulation = {
        coin_id: snapshot.coin_id,
        timeframe: snapshot.timeframe,
        side: decision.side || 'buy',
        entry_price: price,
        stop_loss: decision.side === 'sell' ? price * 1.02 : price * 0.98,
        take_profit: decision.side === 'sell' ? price * 0.96 : price * 1.04,
        confidence_at_entry: decision.confidence,
        decision_data: decision,
        timestamp: new Date()
      };

      await queries.insertSimulatedOperation(simulation);
    } catch (error) {
      logger.error('Error in Simulation run:', error);
    }
  }

  async updateResults(snapshot) {
    // Lógica para fechar operações abertas comparando o preço atual com SL/TP
    // ... (Mantém a lógica de verificação de preço)
  }
}

module.exports = new Simulation();
