const db = require('./connection.js');

const queries = {
  async getInternalCoinId(symbol) {
    try {
      const result = await db.query('SELECT id FROM trading_ai.coins WHERE symbol = $1 OR id = $1 LIMIT 1', [symbol]);
      return result.rows[0]?.id || symbol;
    } catch (e) { return symbol; }
  },

  async getIndicatorWeights(coinId) {
    try {
      let query = 'SELECT * FROM trading_ai.ai_indicator_weights';
      let values = [];
      if (coinId) {
        query += ' WHERE coin_id = $1';
        values = [coinId];
      } else {
        query += ' WHERE coin_id = $1';
        values = ['GLOBAL'];
      }
      const result = await db.query(query, values);
      return result.rows.map(row => ({
        ...row,
        weight: (parseFloat(row.weight) || 0) / 100,
        performance_score: (parseFloat(row.performance_score) || 0) / 100
      }));
    } catch (error) { return []; }
  },

  async updateIndicatorWeight(w) {
    const query = `
      INSERT INTO trading_ai.ai_indicator_weights (indicator_name, coin_id, timeframe, weight, performance_score, last_updated)
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (indicator_name, coin_id, timeframe)
      DO UPDATE SET weight = EXCLUDED.weight, performance_score = EXCLUDED.performance_score, last_updated = NOW();
    `;
    await db.query(query, [
        w.indicator_name,
        w.coin_id || 'GLOBAL',
        w.timeframe || 'ALL',
        Math.round(w.weight * 100),
        Math.round(w.performance_score * 100)
    ]);
  },

  async getGlobalLearning() {
    try {
      const query = 'SELECT * FROM trading_ai.ai_global_learning ORDER BY last_updated DESC LIMIT 1';
      const result = await db.query(query);
      const row = result.rows[0];
      if (row) {
        row.win_rate = (parseFloat(row.win_rate) || 0) / 100;
        row.avg_confidence = (parseFloat(row.avg_confidence || 0)) / 100;
      }
      return row || null;
    } catch (error) { return null; }
  },

  async updateGlobalLearning(stats) {
    try {
      const existing = await this.getGlobalLearning();
      const winRate = Math.round((parseFloat(stats.win_rate) || 0) * 100);
      const avgConfidence = Math.round((parseFloat(stats.avg_confidence) || 0) * 100);

      if (existing) {
        await db.query(
          'UPDATE trading_ai.ai_global_learning SET total_examples = $1, total_decisions = $2, win_rate = $3, avg_confidence = $4, last_updated = NOW() WHERE id = $5',
          [stats.total_examples, stats.total_decisions || 0, winRate, avgConfidence, existing.id]
        );
      } else {
        await db.query(
          'INSERT INTO trading_ai.ai_global_learning (total_examples, total_decisions, win_rate, avg_confidence) VALUES ($1, $2, $3, $4)',
          [stats.total_examples, stats.total_decisions || 0, winRate, avgConfidence]
        );
      }
    } catch (e) { console.error('UpdateGlobalError:', e.message); }
  },

  async insertSimulatedOperation(sim) {
    if (global.dbReadOnly) return;
    const query = `
      INSERT INTO trading_ai.ai_simulated_operations (
        coin_id, timeframe, side, entry_price, stop_loss, take_profit,
        confidence_at_entry, result, profit_loss, timestamp
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
    `;
    const values = [
      sim.coin_id, sim.timeframe, sim.side || 'buy',
      BigInt(Math.round(sim.entry_price * 10000000000)),
      BigInt(Math.round(sim.stop_loss * 10000000000)),
      BigInt(Math.round(sim.take_profit * 10000000000)),
      Math.round(sim.confidence_at_entry * 100),
      sim.result || null,
      sim.profit_loss ? Math.round(sim.profit_loss * 100) : null
    ];
    await db.query(query, values);
  }
};

module.exports = queries;
