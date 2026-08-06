const db = require('./connection.js');

const queries = {
  async getInternalCoinId(symbol) {
    try {
      const result = await db.query('SELECT id FROM trading_ai.coins WHERE symbol = $1 OR id = $1 LIMIT 1', [symbol]);
      return result.rows[0]?.id || symbol;
    } catch (e) { return symbol; }
  },

  async getConfiguration() {
    try {
      const query = 'SELECT * FROM trading_ai.ai_configuration ORDER BY last_updated DESC LIMIT 1';
      const result = await db.query(query);
      const row = result.rows[0];
      if (row) {
        row.learning_rate = (parseFloat(row.learning_rate) || 0) / 100;
        row.confidence_threshold = (parseFloat(row.confidence_threshold) || 0) / 100;
      }
      return row;
    } catch (error) { return null; }
  },

  async getIndicatorWeights(coinId) {
    try {
      let query = 'SELECT * FROM trading_ai.ai_indicator_weights';
      let values = [];
      if (coinId) {
        query += ' WHERE coin_id = $1';
        values = [coinId];
      } else {
        query += ' WHERE coin_id IS NULL';
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
      ON CONFLICT (indicator_name, COALESCE(coin_id, '00000000-0000-0000-0000-000000000000'), COALESCE(timeframe, 'ALL'))
      DO UPDATE SET weight = EXCLUDED.weight, performance_score = EXCLUDED.performance_score, last_updated = NOW();
    `;
    await db.query(query, [
      w.indicator_name,
      w.coin_id || null,
      w.timeframe || null,
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
        row.avg_confidence = (parseFloat(row.avg_confidence) || 0) / 100;
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

  async insertDecision(decision) {
    const query = `
      INSERT INTO trading_ai.ai_decisions (coin_id, timeframe, decision, side, price, confidence, timestamp)
      VALUES ($1, $2, $3, $4, $5, $6, NOW()) RETURNING id;
    `;
    const values = [
      decision.coin_id, decision.timeframe, decision.decision, decision.side || 'buy',
      BigInt(Math.round((parseFloat(decision.price) || 0) * 10000000000)),
      Math.round((parseFloat(decision.confidence) || 0) * 100)
    ];
    try {
      const result = await db.query(query, values);
      return result.rows[0].id;
    } catch (error) {
      if (error.message.includes('type uuid')) {
        const coinId = await this.getInternalCoinId(decision.coin_id);
        const retryValues = [...values]; retryValues[0] = coinId;
        const result = await db.query(query, retryValues);
        return result.rows[0].id;
      }
      throw error;
    }
  },

  async insertPattern(pattern) {
    try {
      const query = `
        INSERT INTO trading_ai.ai_patterns (pattern_name, coin_id, timeframe, pattern_type, success_rate, occurrence_count, pattern_data, last_seen)
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
        ON CONFLICT (pattern_name, coin_id) DO UPDATE SET occurrence_count = trading_ai.ai_patterns.occurrence_count + 1, last_seen = NOW();
      `;
      await db.query(query, [
        pattern.pattern_name, pattern.coin_id, pattern.timeframe, pattern.pattern_type,
        Math.round(pattern.success_rate * 100), 1, JSON.stringify(pattern.pattern_data)
      ]);
    } catch (e) { /* ignore */ }
  },

  async insertLearningLog(log) {
    try {
      await db.query(
        'INSERT INTO trading_ai.ai_learning_logs (log_type, coin_id, message, data, timestamp) VALUES ($1, $2, $3, $4, NOW())',
        [log.log_type, log.coin_id, log.message, JSON.stringify(log.data)]
      );
    } catch (e) { /* ignore */ }
  },

  async insertSimulatedOperation(sim) {
    const query = `
      INSERT INTO trading_ai.ai_simulated_operations
        (coin_id, timeframe, side, entry_price, stop_loss, take_profit, confidence_at_entry, decision_data, timestamp)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
    `;
    const values = [
      sim.coin_id, sim.timeframe, sim.side || 'buy',
      BigInt(Math.round(sim.entry_price * 10000000000)),
      BigInt(Math.round(sim.stop_loss * 10000000000)),
      BigInt(Math.round(sim.take_profit * 10000000000)),
      Math.round(sim.confidence_at_entry * 100),
      JSON.stringify(sim.decision_data)
    ];
    try {
      await db.query(query, values);
    } catch (error) {
      if (error.message.includes('type uuid')) {
        const coinId = await this.getInternalCoinId(sim.coin_id);
        const retryValues = [...values]; retryValues[0] = coinId;
        await db.query(query, retryValues);
      }
    }
  },

  async getOpenSimulatedOperations(coinId = null) {
    try {
      let resolvedId = coinId;
      if (coinId && typeof coinId === 'string' && !coinId.includes('-')) {
        resolvedId = await this.getInternalCoinId(coinId);
      }
      let query = "SELECT * FROM trading_ai.ai_simulated_operations WHERE result IS NULL";
      let params = [];
      if (resolvedId) {
        query += " AND (coin_id = $1 OR coin_id::text = $1)";
        params = [resolvedId];
      }
      const result = await db.query(query, params);
      return result.rows.map(row => ({
        ...row,
        entry_price: parseFloat(row.entry_price) / 10000000000,
        stop_loss: parseFloat(row.stop_loss) / 10000000000,
        take_profit: parseFloat(row.take_profit) / 10000000000
      }));
    } catch (e) {
      console.error('Error fetching open simulations:', e.message);
      return [];
    }
  },

  async updateSimulatedOperation(sim) {
    const query = `
      UPDATE trading_ai.ai_simulated_operations
      SET exit_price = $1, result = $2, profit_loss = $3, duration_seconds = $4
      WHERE id = $5
    `;
    const exitPrice = BigInt(Math.round(sim.exit_price * 10000000000));
    const profitLoss = Math.max(-32000, Math.min(32000, Math.round(sim.profit_loss * 100)));
    await db.query(query, [exitPrice, sim.result, profitLoss, sim.duration_seconds, sim.id]);
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
      const wins = parseInt(row?.total_wins || 0);
      const losses = parseInt(row?.total_losses || 0);
      const closed = wins + losses;
      return {
        ai_examples: parseInt(row?.ai_examples || 0),
        total_real_ops: parseInt(row?.total_real_ops || 0),
        total_simulated_ops: parseInt(row?.total_simulated_ops || 0),
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
  },

  async getCoinLearning(coinId) {
    const r = await db.query('SELECT * FROM trading_ai.ai_coin_learning WHERE coin_id = $1', [coinId]);
    return r.rows[0];
  },

  async updateCoinLearning(s) {
    const safeExamples = Math.min(32767, parseInt(s.total_examples) || 0);
    await db.query(
      'INSERT INTO trading_ai.ai_coin_learning (coin_id, total_examples, win_rate) VALUES ($1, $2, $3) ON CONFLICT (coin_id) DO UPDATE SET total_examples = EXCLUDED.total_examples',
      [s.coin_id, safeExamples, Math.round(s.win_rate * 100)]
    );
  },

  async updateOperationDynamic(symbol, data) {
    try {
      const query = `
        UPDATE trading_ai.operations
        SET
          stop_loss = COALESCE($1, stop_loss),
          take_profit = COALESCE($2, take_profit),
          trailing_stop = COALESCE($3, trailing_stop),
          partial_exit_done = COALESCE($4, partial_exit_done),
          partial_entry_count = COALESCE($5, partial_entry_count),
          last_analysis = $6,
          updated_at = NOW()
        WHERE symbol = $7 AND status = 'OPEN'
      `;
      const sl = data.stop_loss ? BigInt(Math.round(data.stop_loss * 10000000000)) : null;
      const tp = data.take_profit ? BigInt(Math.round(data.take_profit * 10000000000)) : null;
      const ts = data.trailing_stop ? Math.round(parseFloat(data.trailing_stop) * 100) : null;
      await db.query(query, [sl, tp, ts, data.partial_exit_done, data.partial_entry_count, data.reason, symbol]);
    } catch (e) {
      console.error('Error updating dynamic operation:', e.message);
    }
  },

  async getActiveOperation(symbol) {
    try {
      const result = await db.query(
        "SELECT * FROM trading_ai.operations WHERE symbol = $1 AND status = 'OPEN' LIMIT 1",
        [symbol]
      );
      if (result.rows[0]) {
        const row = result.rows[0];
        return {
          ...row,
          entry_price: parseFloat(row.entry_price) / 10000000000,
          stop_loss: row.stop_loss ? parseFloat(row.stop_loss) / 10000000000 : null,
          take_profit: row.take_profit ? parseFloat(row.take_profit) / 10000000000 : null
        };
      }
      return null;
    } catch (e) { return null; }
  }
};

module.exports = queries;
