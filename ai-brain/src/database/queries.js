const db = require('./connection.js');

const queries = {
  // Helper para resolver UUID de moeda
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

  // Obter pesos dos indicadores
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
    } catch (error) {
      return [];
    }
  },

  // FUNÇÃO QUE ESTAVA FALTANDO/DANDO ERRO
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
    } catch (error) {
      console.error('Error in getGlobalLearning:', error.message);
      return null;
    }
  },

  // Inserir Decisão (Correção SMALLINT)
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
      BigInt(Math.round((parseFloat(decision.price) || 0) * 10000000000)),
      Math.round((parseFloat(decision.confidence) || 0) * 100),
      Math.round((parseFloat(decision.win_probability) || 0) * 100),
      Math.round((parseFloat(decision.loss_probability) || 0) * 100),
      Math.round((parseFloat(decision.risk) || 0) * 100),
      Math.round((parseFloat(decision.trend_strength) || 0) * 100),
      Math.round((parseFloat(decision.setup_quality) || 0) * 100),
      JSON.stringify(decision.indicators_summary || {}),
      new Date()
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
    } catch (e) { console.error(e); }
  },

  async getCoinLearning(coinId) {
    const result = await db.query('SELECT * FROM trading_ai.ai_coin_learning WHERE coin_id = $1', [coinId]);
    return result.rows[0];
  },

  async updateCoinLearning(stats) {
    const query = `
      INSERT INTO trading_ai.ai_coin_learning (coin_id, total_examples, total_decisions, win_rate, avg_confidence, last_updated)
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (coin_id) DO UPDATE SET
        total_examples = EXCLUDED.total_examples,
        win_rate = EXCLUDED.win_rate,
        last_updated = NOW();
    `;
    await db.query(query, [stats.coin_id, stats.total_examples, stats.total_decisions, Math.round(stats.win_rate * 100), Math.round(stats.avg_confidence * 100)]);
  },

  async getLiveStats() {
    try {
      const query = `
        SELECT
          (SELECT COUNT(*) FROM trading_ai.ai_decisions) as total_ai_decisions,
          (SELECT total_examples FROM trading_ai.ai_global_learning ORDER BY last_updated DESC LIMIT 1) as ai_examples
      `;
      const result = await db.query(query);
      return {
        ai_examples: parseInt(result.rows[0]?.ai_examples || 0),
        total_ai_decisions: parseInt(result.rows[0]?.total_ai_decisions || 0)
      };
    } catch (e) { return { ai_examples: 0, total_ai_decisions: 0 }; }
  }
};

module.exports = queries;
