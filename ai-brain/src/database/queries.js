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
      if (coinId && coinId !== 'GLOBAL') {
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

  async getCoinLearning(coinId) {
    try {
      const result = await db.query('SELECT * FROM trading_ai.ai_coin_learning WHERE coin_id = $1', [coinId]);
      const row = result.rows[0];
      if (row) {
        row.win_rate = (parseFloat(row.win_rate) || 0) / 100;
        row.avg_confidence = (parseFloat(row.avg_confidence || 0)) / 100;
      }
      return row || null;
    } catch (e) { return null; }
  },

  async updateCoinLearning(stats) {
    try {
      const winRate = Math.round((parseFloat(stats.win_rate) || 0) * 100);
      const avgConfidence = Math.round((parseFloat(stats.avg_confidence) || 0) * 100);

      const query = `
        INSERT INTO trading_ai.ai_coin_learning (coin_id, total_examples, total_decisions, correct_decisions, win_rate, avg_confidence, last_updated)
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
        ON CONFLICT (coin_id) DO UPDATE SET
          total_examples = EXCLUDED.total_examples,
          total_decisions = EXCLUDED.total_decisions,
          correct_decisions = EXCLUDED.correct_decisions,
          win_rate = EXCLUDED.win_rate,
          avg_confidence = EXCLUDED.avg_confidence,
          last_updated = NOW();
      `;
      await db.query(query, [stats.coin_id, stats.total_examples, stats.total_decisions || 0, stats.correct_decisions || 0, winRate, avgConfidence]);
    } catch (e) { console.error('UpdateCoinLearningError:', e.message); }
  },

  async updateOperationDynamic(symbol, data) {
    try {
      let query = "UPDATE trading_ai.operations SET updated_at = NOW()";
      const values = [];
      let i = 1;

      if (data.reason) { query += `, last_analysis = $${i++}`; values.push(data.reason); }
      if (data.partial_exit_done !== undefined) { query += `, partial_exit_done = $${i++}`; values.push(data.partial_exit_done); }
      if (data.partial_entry_count !== undefined) { query += `, partial_entry_count = $${i++}`; values.push(data.partial_entry_count); }
      if (data.stop_loss) { query += `, stop_loss = $${i++}`; values.push(BigInt(Math.round(data.stop_loss * 10000000000))); }
      if (data.trailing_stop) { query += `, trailing_stop = $${i++}`; values.push(BigInt(Math.round(data.trailing_stop * 10000000000))); }

      query += ` WHERE symbol = $${i} AND status = 'OPEN'`;
      values.push(symbol);

      await db.query(query, values);
    } catch (e) { console.error('UpdateDynamicError:', e.message); }
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
  },

  async getOpenSimulatedOperations(coinId) {
    try {
      const query = `
        SELECT * FROM trading_ai.ai_simulated_operations
        WHERE coin_id = $1 AND result IS NULL
        ORDER BY timestamp DESC
      `;
      const result = await db.query(query, [coinId]);
      return result.rows.map(row => ({
        ...row,
        entry_price: parseFloat(row.entry_price) / 10000000000,
        stop_loss: parseFloat(row.stop_loss) / 10000000000,
        take_profit: parseFloat(row.take_profit) / 10000000000,
        confidence_at_entry: parseFloat(row.confidence_at_entry) / 100
      }));
    } catch (e) { return []; }
  },

  async updateSimulatedOperation(sim) {
    if (global.dbReadOnly) return;
    const query = `
      UPDATE trading_ai.ai_simulated_operations
      SET exit_price = $1, result = $2, profit_loss = $3, duration_seconds = $4
      WHERE id = $5
    `;
    await db.query(query, [
      BigInt(Math.round(sim.exit_price * 10000000000)),
      sim.result,
      Math.round(sim.profit_loss * 100),
      sim.duration_seconds,
      sim.id
    ]);
  },

  async getLiveStats() {
    try {
      const query = `
        SELECT
          (SELECT COUNT(*) FROM trading_ai.operations) as total_real_ops,
          (SELECT COUNT(*) FROM trading_ai.ai_simulated_operations) as total_simulated_ops,
          (SELECT COUNT(*) FROM trading_ai.ai_simulated_operations WHERE result = 'win') as total_wins,
          (SELECT COUNT(*) FROM trading_ai.ai_simulated_operations WHERE result = 'loss') as total_losses,
          (SELECT total_examples FROM trading_ai.ai_global_learning ORDER BY last_updated DESC LIMIT 1) as ai_examples,
          (SELECT total_decisions FROM trading_ai.ai_global_learning ORDER BY last_updated DESC LIMIT 1) as total_decisions,
          (SELECT correct_decisions FROM trading_ai.ai_global_learning ORDER BY last_updated DESC LIMIT 1) as correct_decisions,
          (SELECT avg_confidence FROM trading_ai.ai_global_learning ORDER BY last_updated DESC LIMIT 1) as avg_confidence
      `;
      const result = await db.query(query);
      const row = result.rows[0];
      const totalSims = parseInt(row?.total_simulated_ops || 0);
      const wins = parseInt(row?.total_wins || 0);
      const losses = parseInt(row?.total_losses || 0);
      const closed = wins + losses;
      return {
        ai_examples: parseInt(row?.ai_examples || 0),
        total_real_ops: parseInt(row?.total_real_ops || 0),
        total_simulated_ops: totalSims,
        total_decisions: parseInt(row?.total_decisions || 0),
        correct_decisions: parseInt(row?.correct_decisions || 0),
        avg_confidence: (parseFloat(row?.avg_confidence || 0)) / 100,
        wins,
        losses,
        win_rate: closed > 0 ? wins / closed : 0
      };
    } catch (e) {
      console.error('LiveStatsError:', e.message);
      return { ai_examples: 0, total_real_ops: 0, total_simulated_ops: 0, total_decisions: 0, correct_decisions: 0, avg_confidence: 0, wins: 0, losses: 0, win_rate: 0 };
    }
  }
};

module.exports = queries;
