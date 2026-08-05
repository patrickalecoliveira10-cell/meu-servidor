const db = require('./connection');

const queries = {
  // Inserir snapshot do mercado
  async insertMarketSnapshot(snapshot) {
    const query = `
      INSERT INTO trading_ai.scanner_snapshots (
        coin_id, timeframe, open, high, low, close, volume, indicators, timestamp, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, to_timestamp($9/1000.0), NOW())
      ON CONFLICT (coin_id, timeframe, timestamp) DO UPDATE SET
        close = EXCLUDED.close,
        volume = EXCLUDED.volume,
        indicators = EXCLUDED.indicators
      RETURNING id;
    `;
    const values = [
      snapshot.coin_id,
      snapshot.timeframe,
      BigInt(Math.round((snapshot.open || 0) * 10000000000)),
      BigInt(Math.round((snapshot.high || 0) * 10000000000)),
      BigInt(Math.round((snapshot.low || 0) * 10000000000)),
      BigInt(Math.round((snapshot.close || 0) * 10000000000)),
      BigInt(Math.round(parseFloat(snapshot.volume) || 0)),
      JSON.stringify(snapshot.indicators || {}),
      snapshot.timestamp
    ];
    try {
      const result = await db.query(query, values);
      return result.rows[0]?.id;
    } catch (e) {
      console.error(`Error inserting snapshot for ${snapshot.coin_id}:`, e.message);
      return null;
    }
  },

  // Inserir indicadores
  async insertIndicator(indicator) {
    // Mapeia tipos de indicadores para tabelas específicas se existirem prefixo indicator_
    let tableName = indicator.type;
    if (!tableName.startsWith('indicator_')) {
      tableName = `indicator_${tableName.toLowerCase()}`;
    }

    const fullTableName = `trading_ai.${tableName}`;

    const query = `
      INSERT INTO ${fullTableName} (
        coin_id, timeframe, period, value, timestamp, created_at
      ) VALUES ($1, $2, $3, $4, to_timestamp($5/1000.0), NOW())
      ON CONFLICT (coin_id, timeframe, period, timestamp)
      DO UPDATE SET value = EXCLUDED.value
      RETURNING id;
    `;
    const values = [
      indicator.coin_id,
      indicator.timeframe,
      indicator.period,
      BigInt(Math.round((indicator.value || 0) * 10000000000)),
      indicator.timestamp
    ];
    try {
      const result = await db.query(query, values);
      return result.rows[0]?.id;
    } catch (e) {
      console.error(`Error inserting indicator ${indicator.type} for ${indicator.coin_id}:`, e.message);
      return null;
    }
  },

  // Inserir resultado do scanner
  async insertScannerResult(result) {
    // Garante que o session_id é um UUID ou nulo
    const sessionId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result.session_id)
      ? result.session_id
      : null;

    const query = `
      INSERT INTO trading_ai.scanner_results (
        session_id, coin_id, timeframe, score, price, volume, volatility, indicators_matched, timestamp, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, to_timestamp($9/1000.0), NOW())
      RETURNING id;
    `;
    const values = [
      sessionId,
      result.coin_id,
      result.timeframe,
      Math.round(result.score || 0),
      BigInt(Math.round((result.price || 0) * 10000000000)),
      BigInt(Math.round(parseFloat(result.volume) || 0)),
      Math.round(result.volatility || 0),
      JSON.stringify(result.indicators_summary),
      result.timestamp
    ];
    try {
      const dbResult = await db.query(query, values);
      return dbResult.rows[0]?.id;
    } catch (e) {
      console.error(`Error inserting scanner result for ${result.coin_id}:`, e.message);
      return null;
    }
  },

  async createScannerSession(data) {
    try {
      // Check if scanner_sessions table exists, if not, it's a legacy schema
      const query = `INSERT INTO trading_ai.scanner_sessions (status, coins_count, timeframes, start_time) VALUES ('running', $1, $2, NOW()) RETURNING id;`;
      const result = await db.query(query, [data.coins_count, JSON.stringify(data.timeframes)]);
      return result.rows[0].id;
    } catch (e) {
      console.warn('Scanner sessions table might be missing, returning dummy ID');
      return '00000000-0000-0000-0000-000000000000';
    }
  },

  async updateScannerSession(sessionId, data) {
    try {
      const query = `UPDATE trading_ai.scanner_sessions SET status = $1, end_time = NOW(), coins_scanned = $2, snapshots_created = $3, errors_count = $4, duration_seconds = $5 WHERE id = $6;`;
      await db.query(query, [data.status, data.coins_scanned, data.snapshots_created, data.errors_count, data.duration_seconds, sessionId]);
    } catch (e) {
       // Silencioso
    }
  },

  async insertLog(log) {
    try {
      const query = `INSERT INTO trading_ai.logs (level, message, context, source) VALUES ($1, $2, $3, $4) RETURNING id;`;
      const result = await db.query(query, [log.level, log.message, JSON.stringify(log.context), log.source]);
      return result.rows[0]?.id;
    } catch (e) {
      // Silencioso no DB, loga no console
      console.log(`[DB Log Fallback] ${log.level}: ${log.message}`);
      return null;
    }
  },

  async upsertCoin(coin) {
    const query = `
      INSERT INTO trading_ai.coins (id, symbol, name, exchange, is_active, updated_at)
      VALUES ($1, $1, $1, 'bybit', true, NOW())
      ON CONFLICT (id) DO UPDATE SET is_active = true, updated_at = NOW();
    `;
    await db.query(query, [coin.symbol]);
  },

  // BUSCAS PARA O APP ANDROID
  async getRecentResults(limit = 50) {
    const query = `
      SELECT r.id, r.session_id, r.coin_id, r.timeframe, r.score,
             (r.price::float / 10000000000.0) as price,
             r.volume, r.volatility, r.indicators_matched, r.timestamp, r.created_at,
             c.symbol
      FROM trading_ai.scanner_results r
      JOIN trading_ai.coins c ON r.coin_id = c.id
      ORDER BY r.timestamp DESC
      LIMIT $1;
    `;
    const result = await db.query(query, [limit]);
    return result.rows;
  },

  async getCoins(limit = 100) {
    const query = `SELECT * FROM trading_ai.coins ORDER BY updated_at DESC LIMIT $1;`;
    const result = await db.query(query, [limit]);
    return result.rows;
  },

  async getTopOpportunities(limit = 20, minScore = 70) {
    const query = `
      SELECT r.id, r.session_id, r.coin_id, r.timeframe, r.score,
             (r.price::float / 10000000000.0) as price,
             r.volume, r.volatility, r.indicators_matched, r.timestamp, r.created_at,
             c.symbol
      FROM trading_ai.scanner_results r
      JOIN trading_ai.coins c ON r.coin_id = c.id
      WHERE r.score >= $2
      ORDER BY r.score DESC, r.timestamp DESC
      LIMIT $1;
    `;
    const result = await db.query(query, [limit, minScore]);
    return result.rows;
  },

  async getScannerStatistics() {
    try {
      const query = `
        SELECT
          (SELECT COUNT(*) FROM trading_ai.coins) as total_coins,
          (SELECT COUNT(*) FROM trading_ai.scanner_snapshots WHERE created_at > NOW() - INTERVAL '24 hours') as snapshots_24h,
          (SELECT COUNT(*) FROM trading_ai.scanner_results WHERE created_at > NOW() - INTERVAL '24 hours') as results_24h
      `;
      const result = await db.query(query);
      const row = result.rows[0];
      return {
        total_coins: parseInt(row.total_coins || 0),
        snapshots_24h: parseInt(row.snapshots_24h || 0),
        results_24h: parseInt(row.results_24h || 0)
      };
    } catch (e) {
      console.error('Error in getScannerStatistics:', e.message);
      return { total_coins: 0, snapshots_24h: 0, results_24h: 0 };
    }
  }
};

module.exports = queries;
