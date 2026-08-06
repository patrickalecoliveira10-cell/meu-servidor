const db = require('./connection.js');

const queries = {
  // Helper para resolver UUID de moeda se o banco exigir
  async getInternalCoinId(symbol) {
    try {
      const result = await db.query('SELECT id FROM trading_ai.coins WHERE symbol = $1 OR id = $1 LIMIT 1', [symbol]);
      return result.rows[0]?.id || symbol;
    } catch (e) {
      return symbol;
    }
  },

  // AI Configuration
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
    } catch (error) {
      console.error('Error in getConfiguration:', error.message);
      return null;
    }
  },

  async updateConfiguration(configData) {
    const query = `
      UPDATE trading_ai.ai_configuration
      SET mode = $1, min_examples_for_operation = $2, learning_rate = $3,
          confidence_threshold = $4, max_operations_per_day = $5,
          current_examples_count = $6, is_operational = $7, last_updated = NOW()
      WHERE id = (SELECT id FROM trading_ai.ai_configuration ORDER BY last_updated DESC LIMIT 1)
      RETURNING *;
    `;
    const values = [
      configData.mode,
      configData.min_examples_for_operation,
      Math.round((parseFloat(configData.learning_rate) || 0) * 100),
      Math.round((parseFloat(configData.confidence_threshold) || 0) * 100),
      configData.max_operations_per_day,
      configData.current_examples_count,
      configData.is_operational,
    ];
    const result = await db.query(query, values);
    return result.rows[0];
  },

  // Decisions (CORREÇÃO CRÍTICA PARA ERRO 22P02)
  async insertDecision(decision) {
    const query = `
      INSERT INTO trading_ai.ai_decisions (
        coin_id, timeframe, decision, side, price,
        confidence, win_probability, loss_probability, risk,
        trend_strength, setup_quality, indicators_summary, timestamp
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING id;
    `;

    const values = [
      decision.coin_id,
      decision.timeframe,
      decision.decision,
      decision.side || 'buy',
      BigInt(Math.round((parseFloat(decision.price) || 0) * 10000000000)), // Escala 10^10
      Math.round((parseFloat(decision.confidence) || 0) * 100),             // 0.5 -> 50 (SMALLINT)
      Math.round((parseFloat(decision.win_probability) || 0) * 100),
      Math.round((parseFloat(decision.loss_probability) || 0) * 100),
      Math.round((parseFloat(decision.risk) || 0) * 100),
      Math.round((parseFloat(decision.trend_strength) || 0) * 100),
      Math.round((parseFloat(decision.setup_quality) || 0) * 100),
      JSON.stringify(decision.indicators_summary || {}),
      decision.timestamp || new Date(),
    ];

    try {
      const result = await db.query(query, values);
      return result.rows[0].id;
    } catch (error) {
      if (error.message.includes('type uuid')) {
        const coinId = await this.getInternalCoinId(decision.coin_id);
        const retryValues = [...values];
        retryValues[0] = coinId;
        const result = await db.query(query, retryValues);
        return result.rows[0].id;
      }
      throw error;
    }
  },

  // Stats e Learning
  async updateGlobalLearning(stats) {
    try {
      const existing = await this.getGlobalLearning();
      const winRate = Math.round((parseFloat(stats.win_rate) || 0) * 100);
      const avgConfidence = Math.round((parseFloat(stats.avg_confidence) || 0) * 100);

      const query = existing 
        ? `UPDATE trading_ai.ai_global_learning SET total_examples = $1, total_decisions = $2, win_rate = $3, avg_confidence = $4, last_updated = NOW() WHERE id = $5`
        : `INSERT INTO trading_ai.ai_global_learning (total_examples, total_decisions, win_rate, avg_confidence) VALUES ($1, $2, $3, $4)`;
      
      const values = [
        parseInt(stats.total_examples || 0),
        parseInt(stats.total_decisions || 0),
        winRate,
        avgConfidence
      ];
      if (existing) values.push(existing.id);
      
      await db.query(query, values);
    } catch (error) {
      console.error('Error in updateGlobalLearning:', error.message);
    }
  },

  async getLiveStats() {
    try {
      const query = `
        SELECT 
          (SELECT COUNT(*) FROM trading_ai.ai_decisions) as total_ai_decisions,
          (SELECT COUNT(*) FROM trading_ai.ai_simulated_operations) as total_simulated_ops,
          (SELECT total_examples FROM trading_ai.ai_global_learning ORDER BY last_updated DESC LIMIT 1) as ai_examples
      `;
      const result = await db.query(query);
      return {
        ai_examples: parseInt(result.rows[0]?.ai_examples || 0),
        total_ai_decisions: parseInt(result.rows[0]?.total_ai_decisions || 0),
        total_simulated_ops: parseInt(result.rows[0]?.total_simulated_ops || 0)
      };
    } catch (e) {
      return { ai_examples: 0, total_ai_decisions: 0, total_simulated_ops: 0 };
    }
  }
};

module.exports = queries;
