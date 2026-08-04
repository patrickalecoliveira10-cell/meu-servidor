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
      Math.round(configData.learning_rate * 100),
      Math.round(configData.confidence_threshold * 100),
      configData.max_operations_per_day,
      configData.current_examples_count,
      configData.is_operational,
    ];
    const result = await db.query(query, values);
    return result.rows[0];
  },

  // Indicator Weights
  async getIndicatorWeights(coinId) {
    try {
      let query = 'SELECT * FROM trading_ai.ai_indicator_weights';
      let values = [];

      if (arguments.length > 0) {
        if (coinId === null) {
          query += ' WHERE coin_id IS NULL';
        } else {
          query += ' WHERE coin_id = $1';
          values = [coinId];
        }
      }

      const result = await db.query(query, values);
      return result.rows.map(row => ({
        ...row,
        weight: (parseFloat(row.weight) || 0) / 100,
        performance_score: (parseFloat(row.performance_score) || 0) / 100
      }));
    } catch (error) {
      console.error('Error in getIndicatorWeights:', error.message);
      return [];
    }
  },

  async updateIndicatorWeight(w) {
    const query = `
      INSERT INTO trading_ai.ai_indicator_weights (indicator_name, coin_id, timeframe, weight, performance_score, last_updated)
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (indicator_name, coin_id, timeframe) DO UPDATE SET
        weight = EXCLUDED.weight,
        performance_score = EXCLUDED.performance_score,
        last_updated = NOW();
    `;
    const values = [
      w.indicator_name,
      w.coin_id || null,
      w.timeframe || null,
      Math.round((parseFloat(w.weight) || 0) * 100),
      Math.round((parseFloat(w.performance_score) || 0) * 100)
    ];
    return await db.query(query, values);
  },

  // Learning
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

  // Decisions
  async insertDecision(decision) {
    const query = `
      INSERT INTO trading_ai.ai_decisions (
        coin_id, timeframe, decision, side, price,
        confidence, win_probability, loss_probability, risk,
        indicators_summary, timestamp
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING id;
    `;

    let safeTimestamp = decision.timestamp;
    if (!safeTimestamp) {
      safeTimestamp = new Date().toISOString();
    } else if (typeof safeTimestamp === 'number' || !isNaN(Number(safeTimestamp))) {
      safeTimestamp = new Date(Number(safeTimestamp)).toISOString();
    } else if (safeTimestamp instanceof Date) {
      safeTimestamp = safeTimestamp.toISOString();
    }

    const values = [
      decision.coin_id,
      decision.timeframe,
      decision.decision,
      decision.side,
      BigInt(Math.round((parseFloat(decision.price) || 0) * 10000000000)),
      Math.round((parseFloat(decision.confidence) || 0) * 100),
      Math.round((parseFloat(decision.win_probability) || 0) * 100),
      Math.round((parseFloat(decision.loss_probability) || 0) * 100),
      Math.round((parseFloat(decision.risk) || 0) * 100),
      JSON.stringify(decision.indicators_summary || {}),
      safeTimestamp,
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

  // Learning Update Methods
  async updateGlobalLearning(stats) {
    try {
      const existing = await this.getGlobalLearning();
      // Win Rate agora é calculado sobre as simulações, não sobre todos os snapshots
      const winRate = Math.round((parseFloat(stats.win_rate) || 0) * 100);
      const avgConfidence = Math.round((parseFloat(stats.avg_confidence) || 0) * 100);

      if (existing) {
        const query = `
          UPDATE trading_ai.ai_global_learning SET
            total_examples = $1,
            total_decisions = $2,
            correct_decisions = $3,
            win_rate = $4,
            avg_confidence = $5,
            patterns_learned = $6,
            last_updated = NOW()
          WHERE id = $7;
        `;
        const values = [
          parseInt(stats.total_examples || 0),
          parseInt(stats.total_simulations || stats.total_decisions || 0),
          parseInt(stats.correct_decisions || 0),
          winRate,
          avgConfidence,
          JSON.stringify(stats.patterns_learned || {}),
          existing.id
        ];
        await db.query(query, values);
      } else {
        const query = `
          INSERT INTO trading_ai.ai_global_learning (total_examples, total_decisions, correct_decisions, win_rate, avg_confidence, patterns_learned)
          VALUES ($1, $2, $3, $4, $5, $6);
        `;
        const values = [
          parseInt(stats.total_examples || 0),
          parseInt(stats.total_simulations || stats.total_decisions || 0),
          parseInt(stats.correct_decisions || 0),
          winRate,
          avgConfidence,
          JSON.stringify(stats.patterns_learned || {})
        ];
        await db.query(query, values);
      }
    } catch (error) {
      console.error('Error in updateGlobalLearning:', error.message);
    }
  },

  async getCoinLearning(coinId) {
    const result = await db.query('SELECT * FROM trading_ai.ai_coin_learning WHERE coin_id = $1', [coinId]);
    const row = result.rows[0];
    if (row) {
      row.win_rate = (parseFloat(row.win_rate) || 0) / 100;
      row.avg_confidence = (parseFloat(row.avg_confidence) || 0) / 100;
    }
    return row;
  },

  async updateCoinLearning(stats) {
    const query = `
      INSERT INTO trading_ai.ai_coin_learning (coin_id, total_examples, total_decisions, correct_decisions, win_rate, avg_confidence, patterns_learned, last_updated)
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      ON CONFLICT (coin_id) DO UPDATE SET
        total_examples = EXCLUDED.total_examples,
        total_decisions = EXCLUDED.total_decisions,
        correct_decisions = EXCLUDED.correct_decisions,
        win_rate = EXCLUDED.win_rate,
        avg_confidence = EXCLUDED.avg_confidence,
        patterns_learned = EXCLUDED.patterns_learned,
        last_updated = NOW();
    `;
    const values = [
      stats.coin_id,
      stats.total_examples,
      stats.total_decisions,
      stats.correct_decisions,
      Math.round(stats.win_rate * 100),
      Math.round(stats.avg_confidence * 100),
      JSON.stringify(stats.patterns_learned)
    ];
    return await db.query(query, values);
  },

  async getTimeframeLearning(timeframe) {
    const result = await db.query('SELECT * FROM trading_ai.ai_timeframe_learning WHERE timeframe = $1', [timeframe]);
    const row = result.rows[0];
    if (row) {
      row.win_rate = (parseFloat(row.win_rate) || 0) / 100;
      row.avg_confidence = (parseFloat(row.avg_confidence) || 0) / 100;
    }
    return row;
  },

  async updateTimeframeLearning(stats) {
    const query = `
      INSERT INTO trading_ai.ai_timeframe_learning (timeframe, total_examples, total_decisions, correct_decisions, win_rate, avg_confidence, last_updated)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (timeframe) DO UPDATE SET
        total_examples = EXCLUDED.total_examples,
        total_decisions = EXCLUDED.total_decisions,
        correct_decisions = EXCLUDED.correct_decisions,
        win_rate = EXCLUDED.win_rate,
        avg_confidence = EXCLUDED.avg_confidence,
        last_updated = NOW();
    `;
    const values = [
      stats.timeframe,
      parseInt(stats.total_examples || 0),
      parseInt(stats.total_decisions || 0),
      parseInt(stats.correct_decisions || 0),
      Math.min(32767, Math.round((stats.win_rate || 0) * 100)),
      Math.min(32767, Math.round((stats.avg_confidence || 0) * 100))
    ];
    return await db.query(query, values);
  },

  async insertPattern(pattern) {
    const query = `
      INSERT INTO trading_ai.ai_market_patterns (pattern_name, coin_id, timeframe, pattern_type, success_rate, occurrence_count, pattern_data, last_seen)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8);
    `;
    const values = [
      pattern.pattern_name,
      pattern.coin_id,
      pattern.timeframe,
      pattern.pattern_type,
      Math.round(pattern.success_rate * 100),
      pattern.occurrence_count,
      JSON.stringify(pattern.pattern_data),
      pattern.last_seen
    ];
    return await db.query(query, values);
  },

  // Simulation Methods
  async insertSimulatedOperation(sim) {
    const query = `
      INSERT INTO trading_ai.ai_simulated_operations (
        coin_id, timeframe, side, entry_price, stop_loss, take_profit,
        confidence_at_entry, decision_data, timestamp
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id;
    `;
    const values = [
      sim.coin_id,
      sim.timeframe,
      sim.side || 'buy',
      BigInt(Math.round((sim.entry_price || 0) * 10000000000)),
      BigInt(Math.round((sim.stop_loss || 0) * 10000000000)),
      BigInt(Math.round((sim.take_profit || 0) * 10000000000)),
      Math.round((sim.confidence_at_entry || 0) * 100),
      JSON.stringify(sim.decision_data || {}),
      sim.timestamp || new Date()
    ];
    try {
      const result = await db.query(query, values);
      return result.rows[0].id;
    } catch (error) {
      if (error.message.includes('type uuid')) {
        const coinId = await this.getInternalCoinId(sim.coin_id);
        const retryValues = [...values];
        retryValues[0] = coinId;
        const result = await db.query(query, retryValues);
        return result.rows[0].id;
      }
      throw error;
    }
  },

  async getOpenSimulatedOperations() {
    try {
      const query = 'SELECT * FROM trading_ai.ai_simulated_operations WHERE result IS NULL';
      const result = await db.query(query);
      return result.rows.map(row => ({
        ...row,
        entry_price: (parseFloat(row.entry_price) || 0) / 10000000000,
        stop_loss: (parseFloat(row.stop_loss) || 0) / 10000000000,
        take_profit: (parseFloat(row.take_profit) || 0) / 10000000000,
        confidence_at_entry: (parseFloat(row.confidence_at_entry) || 0) / 100
      }));
    } catch (error) {
      console.error('Error in getOpenSimulatedOperations:', error.message);
      return [];
    }
  },

  async updateSimulatedOperation(sim) {
    const query = `
      UPDATE trading_ai.ai_simulated_operations SET
        exit_price = $1, result = $2, profit_loss = $3,
        duration_seconds = $4
      WHERE id = $5;
    `;

    // Sanitização absoluta contra NaN/Infinity para campos SMALLINT e BIGINT
    const toSafeInt = (val) => {
      const n = parseFloat(val);
      return Number.isFinite(n) ? Math.trunc(n) : 0;
    };

    const exitPrice = BigInt(Math.round((parseFloat(sim.exit_price) || 0) * 10000000000));
    const profitLoss = toSafeInt((parseFloat(sim.profit_loss) || 0) * 100);
    const duration = toSafeInt(sim.duration_seconds);

    // Garantir que profitLoss caiba no smallint do Postgres (-32768 a 32767)
    const safeProfitLoss = Math.max(-32000, Math.min(32000, profitLoss));

    return await db.query(query, [
      exitPrice,
      sim.result,
      safeProfitLoss,
      duration,
      sim.id
    ]);
  },

  async updateDailyStatistics(stats) {
    const query = `
      INSERT INTO trading_ai.ai_daily_statistics (
        date, total_decisions, correct_decisions, win_rate,
        avg_confidence, operations_analyzed, patterns_found, learning_updates
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (date)
      DO UPDATE SET
        total_decisions = EXCLUDED.total_decisions,
        correct_decisions = EXCLUDED.correct_decisions,
        win_rate = EXCLUDED.win_rate,
        avg_confidence = EXCLUDED.avg_confidence,
        operations_analyzed = EXCLUDED.operations_analyzed,
        updated_at = NOW()
      RETURNING *;
    `;
    const values = [
      stats.date,
      stats.total_decisions || 0,
      stats.correct_decisions || 0,
      Math.round((stats.win_rate || 0) * 100),
      Math.round((stats.avg_confidence || 0) * 100),
      stats.operations_analyzed || 0,
      stats.patterns_found || 0,
      stats.learning_updates || 0
    ];
    const result = await db.query(query, values);
    return result.rows[0];
  },

  async cleanupDatabaseSafe(days = 2) {
    try {
      await db.query(`DELETE FROM trading_ai.ai_decisions WHERE timestamp < NOW() - INTERVAL '${days} days'`);
      await db.query(`DELETE FROM trading_ai.ai_learning_logs WHERE timestamp < NOW() - INTERVAL '${days} days'`);
      await db.query('VACUUM trading_ai.ai_decisions');
      return true;
    } catch (e) {
      console.error('Erro na limpeza:', e.message);
      return false;
    }
  },

  async hardResetDatabase() {
    try {
      const tables = [
        'trading_ai.ai_decisions',
        'trading_ai.ai_simulated_operations',
        'trading_ai.ai_learning_logs',
        'trading_ai.ai_operation_management',
        'trading_ai.ai_market_patterns',
        'trading_ai.ai_daily_statistics',
        'trading_ai.ai_coin_learning',
        'trading_ai.ai_global_learning'
      ];
      for (const table of tables) {
        await db.query(`TRUNCATE TABLE ${table} CASCADE`);
      }

      // Reset da configuração de exemplos
      await db.query('UPDATE trading_ai.ai_configuration SET current_examples_count = 0, mode = \'observation\', is_operational = false');

      return true;
    } catch (e) {
      console.error('Erro no hard reset:', e.message);
      throw e;
    }
  },

  async insertLearningLog(log) {
    const query = `
      INSERT INTO trading_ai.ai_learning_logs (
        log_type, coin_id, timeframe, message, data, timestamp
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id;
    `;
    const values = [
      log.log_type,
      log.coin_id || null,
      log.timeframe || null,
      log.message,
      JSON.stringify(log.data),
      log.timestamp || new Date(),
    ];
    const result = await db.query(query, values);
    return result.rows[0].id;
  },

  async insertOperationManagement(m) {
    const query = `
      INSERT INTO trading_ai.ai_operation_management (
        operation_id, coin_id, timeframe, current_price, entry_price,
        stop_loss, take_profit, decision, confidence, reason,
        partial_exit_percent, timestamp
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING id;
    `;
    const values = [
      m.operation_id,
      m.coin_id,
      m.timeframe,
      BigInt(Math.round(m.current_price * 10000000000)),
      BigInt(Math.round(m.entry_price * 10000000000)),
      BigInt(Math.round(m.stop_loss * 10000000000)),
      BigInt(Math.round(m.take_profit * 10000000000)),
      m.decision,
      Math.round(m.confidence * 100),
      m.reason,
      Math.round(m.partial_exit_percent * 100),
      m.timestamp || new Date()
    ];
    const result = await db.query(query, values);
    return result.rows[0].id;
  },

  async getRecentDecisions(limit = 100) {
    try {
      const query = 'SELECT * FROM trading_ai.ai_decisions ORDER BY timestamp DESC LIMIT $1';
      const result = await db.query(query, [limit]);
      return result.rows.map(row => ({
        ...row,
        price: (parseFloat(row.price) || 0) / 10000000000,
        confidence: (parseFloat(row.confidence) || 0) / 100,
        win_probability: (parseFloat(row.win_probability) || 0) / 100,
        loss_probability: (parseFloat(row.loss_probability) || 0) / 100,
        risk: (parseFloat(row.risk) || 0) / 100
      }));
    } catch (error) {
      console.error('Error in getRecentDecisions:', error.message);
      return [];
    }
  },

  async getLiveStats() {
    try {
      const query = `
        SELECT
          (SELECT COUNT(*) FROM trading_ai.ai_decisions) as total_ai_decisions,
          (SELECT COUNT(*) FROM trading_ai.ai_simulated_operations) as total_simulated_ops,
          (SELECT COUNT(*) FROM trading_ai.ai_simulated_operations WHERE result = 'win') as wins,
          (SELECT COUNT(*) FROM trading_ai.ai_simulated_operations WHERE result = 'loss') as losses,
          (SELECT COUNT(*) FROM trading_ai.ai_market_patterns) as total_patterns,
          (SELECT total_examples FROM trading_ai.ai_global_learning ORDER BY last_updated DESC LIMIT 1) as ai_examples
      `;
      const result = await db.query(query);
      const row = result.rows[0];

      const totalSims = parseInt(row?.total_simulated_ops || 0);
      const wins = parseInt(row?.wins || 0);
      const losses = parseInt(row?.losses || 0);
      const calculatedWinRate = totalSims > 0 ? (wins / (wins + losses)) : 0;

      return {
        ai_examples: parseInt(row?.ai_examples || 0),
        total_ai_decisions: parseInt(row?.total_ai_decisions || 0),
        total_simulated_ops: totalSims,
        total_patterns: parseInt(row?.total_patterns || 0),
        total_snapshots: parseInt(row?.ai_examples || 0),
        calculatedWinRate: calculatedWinRate,
        wins: wins,
        losses: losses
      };
    } catch (e) {
      console.error('Error in getLiveStats:', e.message);
      return { ai_examples: 0, total_ai_decisions: 0, total_simulated_ops: 0, total_patterns: 0, total_snapshots: 0, calculatedWinRate: 0 };
    }
  },

  async getLatestSnapshot(coinId) {
    try {
      const query = 'SELECT * FROM trading_ai.scanner_snapshots WHERE coin_id = $1 ORDER BY timestamp DESC LIMIT 1';
      const result = await db.query(query, [coinId]);
      return result.rows[0] || null;
    } catch (error) {
      console.error('Error in getLatestSnapshot:', error.message);
      return null;
    }
  }
};

module.exports = queries;
