const logger = require('../logs/logger.js');
const queries = require('../database/queries.js');

class Intelligence {
  async analyze(snapshot, weights, config) {
    try {
      const { coin_id, indicators } = snapshot;
      const rsi = indicators?.rsi?.value || indicators?.RSI || 50;
      
      // Lógica de confiança simplificada para evitar erros
      let confidence = 0.5;
      let reason = "Analisando mercado...";

      if (rsi < 30) { confidence = 0.85; reason = "Sobrevendido (RSI Baixo). Chance de alta."; }
      else if (rsi > 70) { confidence = 0.85; reason = "Sobrecomprado (RSI Alto). Chance de queda."; }
      else { reason = `RSI neutro em ${parseFloat(rsi).toFixed(0)}. Aguardando sinal.`; }

      const decision = confidence > (config?.confidence_threshold || 0.7) ? 'enter' : 'wait';

      return {
        coin_id,
        timeframe: snapshot.timeframe,
        decision,
        side: rsi < 50 ? 'buy' : 'sell',
        confidence,
        price: parseFloat(snapshot.close || snapshot.price || 0),
        stayReason: reason,
        timestamp: new Date()
      };
    } catch (e) {
      return { coin_id: snapshot.coin_id, decision: 'wait', confidence: 0.5, stayReason: "Erro na análise." };
    }
  }
}

module.exports = new Intelligence();
