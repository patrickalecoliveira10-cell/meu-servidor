const logger = require('../logs/logger.js');

class Intelligence {
  constructor() {
    this.minConfidence = 0.60;
  }

  async init(brain) { this.brain = brain; }

  async analyze(snapshot, weights, config) {
    try {
      const ind = snapshot.indicators || {};
      let score = 0;
      if (ind.rsi?.value < 40) score += 0.4;
      if (ind.macd?.histogram > 0) score += 0.3;
      if (ind.supertrend?.signal === 'bullish') score += 0.3;

      const confidence = Math.min(1, score);
      return {
        coin_id: snapshot.coin_id,
        decision: confidence >= this.minConfidence ? 'enter' : 'wait',
        confidence,
        side: 'buy',
        price: parseFloat(snapshot.close),
        stayReason: `Sniper ${Math.round(confidence*100)}%`,
        indicators_summary: ind,
        timestamp: new Date()
      };
    } catch (e) { return { decision: 'wait', confidence: 0 }; }
  }

  analyzeLivePosition(snapshot, position) {
    const current = parseFloat(snapshot.price || snapshot.close);
    const entry = parseFloat(position.entry_price);
    const profit = ((current - entry) / entry) * 100;
    if (profit >= 1.0) return { action: 'move_stop', params: { new_stop: entry }, reason: "Breakeven" };
    return { action: 'hold', reason: `Lucro: ${profit.toFixed(2)}%` };
  }
}

module.exports = Intelligence;
