const db = require('./connection.js');

const queries = {
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

  async getLiveStats() {
    try {
      const query = `
        SELECT
          (SELECT COUNT(*) FROM trading_ai.operations) as total_real_ops,
          (SELECT COUNT(*) FROM trading_ai.ai_simulated_operations) as total_simulated_ops,
          (SELECT total_examples FROM trading_ai.ai_global_learning ORDER BY last_updated DESC LIMIT 1) as ai_examples
      `;
      const result = await db.query(query);
      const row = result.rows[0];
      return {
        ai_examples: parseInt(row?.ai_examples || 0),
        total_real_ops: parseInt(row?.total_real_ops || 0),
        total_simulated_ops: parseInt(row?.total_simulated_ops || 0)
      };
    } catch (e) { return { ai_examples: 0, total_real_ops: 0, total_simulated_ops: 0 }; }
  }
};

module.exports = queries;
