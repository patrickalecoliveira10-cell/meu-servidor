const logger = require('../logs/logger.js');
const queries = require('../database/queries.js');
const apiClient = require('../utils/api-client.js');
const Intelligence = require('./intelligence.js');

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
      const { coin_id, current_price, entry_price, indicators } = operation;

      logger.debug(`Reevaluating operation for ${coin_id} at ${current_price}`);

      let decision = 'hold';
      let reason = 'Market conditions stable';
      let params = {};

      // CÁLCULOS DE PERFORMANCE
      const profit = operation.side === 'Buy' || operation.side === 'Long'
        ? (current_price - entry_price)
        : (entry_price - current_price);

      const profitPct = (profit / entry_price) * 100;
      const atrValue = indicators.atr ? parseFloat(indicators.atr.value) : (current_price * 0.01);

      // 1. PROTEÇÃO DE CAPITAL (BREAKEVEN)
      // Se o lucro bater 0.8%, move o Stop para o preço de entrada (Garante taxa paga)
      const isBreakevenAlreadySet = operation.side === 'Buy'
        ? (operation.stopLoss >= entry_price)
        : (operation.stopLoss <= entry_price && operation.stopLoss > 0);

      if (profitPct >= 0.8 && !isBreakevenAlreadySet) {
        decision = 'move_stop';
        // Preço de entrada + 0.1% para cobrir taxas da exchange
        params.new_stop = entry_price * (operation.side === 'Buy' || operation.side === 'Long' ? 1.001 : 0.999);
        reason = `Profit ${profitPct.toFixed(2)}% reached. Moving Stop to Breakeven.`;
        operation.breakeven_done = true;
      }

      // 2. TRAILING STOP DINÂMICO (Ativação com 0.6 ATR)
      if (profit > (atrValue * 0.6) && !operation.ts_active) {
        decision = 'activate_trailing';
        // Calcula a distância absoluta em vez de apenas retornar um valor fixo
        params.trailing_stop = (atrValue * 0.4).toFixed(8);
        reason = `Lucro superou 0.6 ATR (${profitPct.toFixed(2)}%). Ativando Trailing Stop nativo.`;
        operation.ts_active = true;
      }

      // 3. SAÍDA PARCIAL (Alvo curto de 1.2 ATR)
      if (profit > (atrValue * 1.2) && !operation.p_exit_done) {
        decision = 'partial_exit';
        params.percent = 0.5;
        reason = 'Target 1 reached (1.2 ATR). Closing 50% to secure profit.';
        operation.p_exit_done = true;
      }

      // 4. SAÍDA ANTECIPADA (STOP PREVENTIVO) - MAIS AGRESSIVO
      if (profitPct < -0.5) { // Começa a monitorar cedo, a partir de -0.5%
        const reAnalysis = await Intelligence.analyze({
            coin_id: operation.coin_id,
            indicators: indicators,
            price: current_price,
            timeframe: operation.timeframe || '15m'
        }, weights, config);

        logger.info(`[MANAGEMENT] ${coin_id} Re-analysis: Confiança ${(reAnalysis.confidence * 100).toFixed(1)}% | ROI Atual: ${profitPct.toFixed(2)}%`);

        // Se a confiança na direção atual cair abaixo de 50%, fecha preventivamente
        if (reAnalysis.confidence < 0.50) {
            decision = 'close';
            reason = `Alto risco detectado: ROI ${profitPct.toFixed(2)}% e Confiança de recuperação abaixo de 50% (${(reAnalysis.confidence * 100).toFixed(1)}%).`;
        }
      }

      // 5. STOP LOSS DE EMERGÊNCIA (Hard Stop)
      // Se cair abaixo de -3.5%, fecha independente da análise da IA para evitar liquidação
      if (profitPct < -3.5) {
          decision = 'close';
          reason = `Emergency Hard Stop triggered at ${profitPct.toFixed(2)}% to protect capital.`;
      }

      // LOG DE MONITORAMENTO E EXPLICAÇÃO PARA O APP
      if (decision === 'hold') {
          if (profitPct < 0 && profitPct > -0.5) {
              reason = "Posição levemente negativa, mas dentro da oscilação normal. Indicadores ainda sugerem força, mantendo para recuperação.";
          } else if (profitPct <= -0.5) {
              reason = `Atenção: ROI em ${profitPct.toFixed(2)}%. Reanalisando probabilidade de recuperação... Status: SAFE por enquanto.`;
          } else {
              reason = "Posição em lucro. Aguardando alvos de saída parcial ou ativação de trailing stop.";
          }
          logger.info(`[MANAGEMENT] Monitoring ${coin_id}: ROI ${profitPct.toFixed(2)}% | Status: SAFE`);
      }

      const managementDecision = {
        operation_id: operation.id,
        coin_id,
        decision,
        params,
        reason, // Agora enviamos a explicação humana
        profit_pct: profitPct,
        timestamp: new Date()
      };

      if (decision !== 'hold') {
        logger.info(`[MANAGEMENT] ${coin_id}: ${reason}`);
        await apiClient.sendManagementSignal(managementDecision);
      }

      return managementDecision;
    } catch (error) {
      logger.error('Error in Management reevaluation:', error);
      throw error;
    }
  }
}

module.exports = new Management();
