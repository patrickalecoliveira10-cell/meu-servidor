const logger = require('../logs/logger.js');
const queries = require('../database/queries.js');

class Simulation {
  constructor() {
    this.brain = null;
    this.learning = null;
  }

  async init(brain) {
    this.brain = brain;
    // Lazy load learning to avoid circular dependency at boot
    this.learning = require('./learning.js');
    logger.info('Simulation module initialized');
  }

  async run(snapshot, decision) {
    try {
      // 1. Check/Update existing simulations first
      await this.updateResults(snapshot);

      if (decision.decision !== 'enter') return;

      // Prevent duplicate open orders for the same coin and timeframe
      const openSims = await queries.getOpenSimulatedOperations();
      const alreadyOpen = openSims.find(s => s.coin_id === snapshot.coin_id && s.timeframe === snapshot.timeframe);
      if (alreadyOpen) return;

      logger.info(`Running simulation for ${snapshot.coin_id}...`);

      // Usar 'close' ou 'price' garantindo que seja um float
      const price = parseFloat(snapshot.close || snapshot.price || snapshot.indicators?.price || 0);
      if (price === 0) return;

      const isSell = decision.side === 'sell';

      // Criar uma operação simulada (preços como float, queries.js converterá para int)
      const simulation = {
        coin_id: snapshot.coin_id,
        timeframe: snapshot.timeframe,
        side: decision.side || 'buy',
        entry_price: price,
        // Alvos mais realistas: SL de 1.5% e TP de 3% (Sniper)
        stop_loss: isSell ? price * 1.015 : price * 0.985,
        take_profit: isSell ? price * 0.97 : price * 1.03,
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
    try {
      const openSims = await queries.getOpenSimulatedOperations();
      const rawPrice = snapshot.price || snapshot.close || snapshot.indicators?.price;

      if (!rawPrice || openSims.length === 0) return;

      const currentPrice = parseFloat(rawPrice);

      for (const sim of openSims) {
        if (sim.coin_id !== snapshot.coin_id) continue;

        let result = null;
        let exitPrice = null;

        // Compare using floats (sim.take_profit/stop_loss are already unscaled by queries.js)
        if (sim.side === 'buy' || !sim.side) {
          if (currentPrice >= sim.take_profit) {
            result = 'win';
            exitPrice = sim.take_profit;
          } else if (currentPrice <= sim.stop_loss) {
            result = 'loss';
            exitPrice = sim.stop_loss;
          }
        } else if (sim.side === 'sell') {
          if (currentPrice <= sim.take_profit) {
            result = 'win';
            exitPrice = sim.take_profit;
          } else if (currentPrice >= sim.stop_loss) {
            result = 'loss';
            exitPrice = sim.stop_loss;
          }
        }

        if (result) {
          const entryPrice = parseFloat(sim.entry_price);
          const exitPriceVal = parseFloat(exitPrice);

          let profitLoss = 0;
          if (entryPrice > 0 && isFinite(exitPriceVal)) {
            profitLoss = sim.side === 'sell'
              ? ((entryPrice - exitPriceVal) / entryPrice) * 100
              : ((exitPriceVal - entryPrice) / entryPrice) * 100;
          }

          // Validação final para evitar crash no banco (Postgres smallint)
          if (isNaN(profitLoss) || !isFinite(profitLoss)) {
            profitLoss = 0;
          }

          // Limita o lucro/prejuízo ao range do smallint se necessário (ex: +/- 300%)
          // O queries.js multiplica por 100, então 327% -> 32700
          profitLoss = Math.max(-320, Math.min(320, profitLoss));

          const duration = Math.floor((new Date() - new Date(sim.timestamp)) / 1000);

          await queries.updateSimulatedOperation({
            id: sim.id,
            exit_price: exitPriceVal,
            result,
            profit_loss: profitLoss,
            duration_seconds: duration
          });

          logger.info(`Simulation closed for ${sim.coin_id}: ${result.toUpperCase()} (${profitLoss.toFixed(2)}%)`);

          // Feedback to Learning module to adjust weights
          if (this.learning) {
            await this.learning.adjustWeightsBasedOnResult(sim, result === 'win');
          }
        }
      }
    } catch (error) {
      logger.error('Error updating simulation results:', error);
    }
  }
}

module.exports = new Simulation();
