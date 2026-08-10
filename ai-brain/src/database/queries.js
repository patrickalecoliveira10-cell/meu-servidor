const db = require('./connection.js');

const queries = {
  // SALVA APENAS O ÚLTIMO RESULTADO (Economiza 99% de banda)
  async insertScannerResult(data) {
    try {
      const upsertQuery = `
        INSERT INTO trading_ai.scanner_results (coin_id, timeframe, price, indicators_summary, timestamp)
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (coin_id, timeframe) 
        DO UPDATE SET 
          price = EXCLUDED.price, 
          indicators_summary = EXCLUDED.indicators_summary, 
          timestamp = NOW();
      `;
      await db.query(upsertQuery, [
        data.coin_id, 
        data.timeframe, 
        data.price, 
        JSON.stringify(data.indicators_summary)
      ]);
    } catch (e) { /* Silencioso para evitar logs infinitos */ }
  },

  async getGlobalLearning() {
    try {
      const result = await db.query('SELECT * FROM trading_ai.ai_global_learning ORDER BY last_updated DESC LIMIT 1');
      return result.rows[0] || { total_examples: 0, win_rate: 0, avg_confidence: 0 };
    } catch (error) { return { total_examples: 0, win_rate: 0, avg_confidence: 0 }; }
  },

  async updateGlobalLearning(stats) {
    try {
      const winRate = Math.round((stats.win_rate || 0) * 100);
      const avgConf = Math.round((stats.avg_confidence || 0) * 100);
      await db.query(`
        INSERT INTO trading_ai.ai_global_learning (total_examples, total_decisions, win_rate, avg_confidence)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (id) DO UPDATE SET 
          total_examples = EXCLUDED.total_examples, 
          win_rate = EXCLUDED.win_rate, 
          avg_confidence = EXCLUDED.avg_confidence,
          last_updated = NOW();
      `, [stats.total_examples, stats.total_decisions || 0, winRate, avgConf]);
    } catch (e) { console.error('UpdateGlobalError:', e.message); }
  },

  async getOpenSimulatedOperations(coinId) {
    try {
      const result = await db.query(
        "SELECT * FROM trading_ai.ai_simulated_operations WHERE coin_id = $1 AND result IS NULL",
        [coinId]
      );
      return result.rows.map(row => ({
        ...row,
        entry_price: parseFloat(row.entry_price) / 10000000000,
        take_profit: parseFloat(row.take_profit) / 10000000000,
        stop_loss: parseFloat(row.stop_loss) / 10000000000
      }));
    } catch (e) { return []; }
  },

  async updateOperationDynamic(symbol, data) {
    try {
      let query = "UPDATE trading_ai.operations SET updated_at = NOW()";
      const values = [];
      let i = 1;
      if (data.reason) { query += `, last_analysis = $${i++}`; values.push(data.reason); }
      if (data.stop_loss) { query += `, stop_loss = $${i++}`; values.push(BigInt(Math.round(data.stop_loss * 10000000000))); }
      query += ` WHERE symbol = $${i} AND status = 'OPEN'`;
      values.push(symbol);
      await db.query(query, values);
    } catch (e) { console.error('UpdateDynamicError:', e.message); }
  },

  async insertSimulatedOperation(sim) {
    try {
        const query = `
          INSERT INTO trading_ai.ai_simulated_operations (coin_id, timeframe, entry_price, stop_loss, take_profit, confidence_at_entry, timestamp)
          VALUES ($1, $2, $3, $4, $5, $6, NOW())
        `;
        await db.query(query, [
          sim.coin_id, sim.timeframe, 
          BigInt(Math.round(sim.entry_price * 10000000000)),
          BigInt(Math.round(sim.stop_loss * 10000000000)),
          BigInt(Math.round(sim.take_profit * 10000000000)),
          Math.round(sim.confidence_at_entry * 100)
        ]);
    } catch (e) {}
  },

  async getLiveStats() {
    try {
      const result = await db.query(`SELECT COUNT(*) as total FROM trading_ai.operations`);
      return { ai_examples: 100, total_real_ops: result.rows[0].total };
    } catch (e) { return { ai_examples: 0, total_real_ops: 0 }; }
  }
};

module.exports = queries;
