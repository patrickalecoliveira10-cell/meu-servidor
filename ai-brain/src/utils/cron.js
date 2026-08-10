const db = require('./connection');
const logger = require('../logs/logger');

const cronTasks = {
    async runDailyCleanup() {
        try {
            logger.info('[CRON] Limpeza de Bandwidth...');
            await db.query("DELETE FROM trading_ai.logs WHERE timestamp < NOW() - INTERVAL '1 day'");
            await db.query("DELETE FROM trading_ai.scanner_results WHERE timestamp < NOW() - INTERVAL '6 hours'");
            await db.query("DELETE FROM trading_ai.ai_simulated_operations WHERE timestamp < NOW() - INTERVAL '2 days'");
            await db.query('VACUUM ANALYZE');
            logger.info('[CRON] OK.');
        } catch (e) { logger.error('[CRON] Erro:', e.message); }
    },
    async keepAlive() {
        try { await db.query('SELECT 1'); } catch (e) {}
    }
};

setInterval(() => cronTasks.runDailyCleanup(), 3600000); // 1 hora
setInterval(() => cronTasks.keepAlive(), 300000); // 5 min

module.exports = cronTasks;
