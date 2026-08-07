const db = require('./connection');

const queries = {
  async insertMarketSnapshot(snapshot) {
    return 'skipped';
  },

  async insertIndicator(indicator) {
    return 'skipped';
  },

  async insertScannerResult(result) {
    const sessionId = (result.session_id && result.session_id.length === 36) ? result.session_id : null;

    const query = `
      INSERT INTO trading_ai.scanner_results (
        session_id, coin_id, timeframe, score, price, volume, volatility, indicators_matched, timestamp
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, to_timestamp($9/1000.0))
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
      const query = `INSERT INTO trading_ai.scanner_sessions (status, coins_count, timeframes, start_time) VALUES ('running', $1, $2, NOW()) RETURNING id;`;
      const result = await db.query(query, [data.coins_count, JSON.stringify(data.timeframes)]);
      return result.rows[0].id;
    } catch (e) {
      console.warn('[SCANNER] Falha ao criar sessão.');
      return null;
    }
  },

  async updateScannerSession(sessionId, data) {
    try {
      const query = `UPDATE trading_ai.scanner_sessions SET status = $1, end_time = NOW(), coins_scanned = $2, snapshots_created = $3, errors_count = $4, duration_seconds = $5 WHERE id = $6;`;
      await db.query(query, [data.status, data.coins_scanned, data.snapshots_created, data.errors_count, data.duration_seconds, sessionId]);
    } catch (e) {}
  },

  async insertLog(log) {
    try {
      if (global.dbReadOnly) return null;
      const query = `INSERT INTO trading_ai.logs (level, message, context, source) VALUES ($1, $2, $3, $4) RETURNING id;`;
      const result = await db.query(query, [log.level, log.message, JSON.stringify(log.context), log.source]);
      return result.rows[0]?.id;
    } catch (e) {
      if (e.message.includes('read-only')) global.dbReadOnly = true;
      return null;
    }
  },

  async upsertCoin(coin) {
    try {
      const query = `
        INSERT INTO trading_ai.coins (id, symbol, name, exchange, is_active, updated_at)
        VALUES ($1, $1, $1, 'bybit', true, NOW())
        ON CONFLICT (id) DO UPDATE SET is_active = true, updated_at = NOW();
      `;
      await db.query(query, [coin.symbol]);
    } catch (e) {
      const fallbackQuery = `
        INSERT INTO trading_ai.coins (id, symbol, name, exchange, is_active)
        VALUES ($1, $1, $1, 'bybit', true)
        ON CONFLICT (id) DO UPDATE SET is_active = true;
      `;
      await db.query(fallbackQuery, [coin.symbol]);
    }
  }
};

module.exports = queries;
