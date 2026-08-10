const db = require('./connection');
const logger = require('../logs/logger');

const cronTasks = {
    async runDailyCleanup() {
        try {
            logger.info('[CRON] Iniciando limpeza agressiva...');
            // Remove logs com mais de 24h
            await db.query("DELETE FROM trading_ai.logs WHERE timestamp < NOW() - INTERVAL '1 day'");
            // Remove simulações de perda antigas
            await db.query("DELETE FROM trading_ai.ai_simulated_operations WHERE result = 'loss' AND timestamp < NOW() - INTERVAL '6 hours'");
            // Limpa espaço em disco
            await db.query('VACUUM ANALYZE');
            logger.info('[CRON] Limpeza concluída.');
        } catch (e) { logger.error('[CRON] Erro:', e.message); }
    }
};

// Executa limpeza a cada 1 hora
setInterval(() => cronTasks.runDailyCleanup(), 3600000);

module.exports = cronTasks;
