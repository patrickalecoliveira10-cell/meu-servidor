const logger = require('../logs/logger.js');
const queries = require('../database/queries.js');
const apiClient = require('../utils/api-client.js');

class Management {
  constructor() {
    this.brain = null;
  }

  async init(brain) {
    this.brain = brain;
    logger.info('Management module initialized');
  }

  async reevaluate(operation, weights, config) {
    try {
      const { coin_id, current_price, entry_price, stop_loss, take_profit, indicators } = operation;

      logger.debug(`Reevaluating operation for ${coin_id} at ${current_price}`);

      // 1. Calculate probabilities
      const winProbability = 0.6; // Placeholder
      const confidence = winProbability;

      let decision = 'hold';
      let reason = 'Market conditions stable';
      let params = {};

      const atrValue = indicators.atr ? parseFloat(indicators.atr.value) : (current_price * 0.02);
      const profit = operation.side === 'Buy' ? (current_price - entry_price) : (entry_price - current_price);

      // 2. Trailing Stop Dinâmico (Ativa quando lucro > 1.2 ATR)
      if (profit > (atrValue * 1.2) && !operation.ts_active) {
        decision = 'activate_trailing';
        params.trailing_stop = (atrValue * 0.7).toFixed(6);
        reason = 'Profit > 1.2 ATR. Activating Native Trailing Stop.';
      }

      // 3. Parcial de Saída (50% no lucro de 2 ATR)
      if (profit > (atrValue * 2.0) && !operation.p_exit_done) {
        decision = 'partial_exit';
        params.percent = 0.5;
        reason = 'Target 1 reached (2 ATR). Closing 50%.';
      }

      const managementDecision = {
        operation_id: operation.id,
        coin_id,
        decision,
        params,
        reason,
        timestamp: new Date()
      };

      if (decision !== 'hold') {
        logger.info(`[MANAGEMENT] Decision for ${coin_id}: ${decision}`);
        await apiClient.sendManagementSignal(managementDecision);

        // Atualizar flags locais para evitar re-execução
        if (decision === 'partial_exit') operation.p_exit_done = true;
        if (decision === 'activate_trailing') operation.ts_active = true;
      }

      return managementDecision;
    } catch (error) {
      logger.error('Error in Management reevaluation:', error);
      throw error;
    }
  }
}


module.exports = new Management();
