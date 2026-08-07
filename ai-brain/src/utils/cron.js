const db = require('./connection');
const logger = require('../logs/logger');

const cronTasks = {
    async runDailyCleanup() {
        try {
            logger.info('[CRON] Iniciando limpeza diária para otimização de 512MB...');

            // 1. Remove logs com mais de 3 dias
            await db.query("DELETE FROM trading_ai.logs WHERE timestamp < NOW() - INTERVAL '3 days'");

            // 2. Remove snapshots de aprendizado com confiança baixa (conhecimento inútil)
            await db.query("DELETE FROM trading_ai.ai_simulated_operations WHERE confidence_at_entry < 40 AND result = 'loss'");

            // 3. Mantém apenas as últimas 500 operações simuladas por moeda para economizar espaço
            await db.query(`
                DELETE FROM trading_ai.ai_simulated_operations
                WHERE id NOT IN (
                    SELECT id FROM trading_ai.ai_simulated_operations
                    ORDER BY timestamp DESC LIMIT 5000
                )
            `);

            // 4. Executa VACUUM para recuperar espaço em disco fisicamente
            await db.query('VACUUM ANALYZE');

            logger.info('[CRON] Limpeza concluída com sucesso.');
        } catch (e) {
            logger.error('[CRON] Falha na limpeza:', e.message);
        }
    },

    // Função de Heartbeat para manter o servidor acordado no Render
    async keepAlive() {
        try {
            await db.query('SELECT 1');
            // logger.debug('[HEARTBEAT] Conexão ativa.');
        } catch (e) {}
    }
};

// Agendar tarefas se não estiver em ambiente de teste
if (process.env.NODE_ENV !== 'test') {
    setInterval(() => cronTasks.runDailyCleanup(), 24 * 60 * 60 * 1000); // 24h
    setInterval(() => cronTasks.keepAlive(), 5 * 60 * 1000); // 5 min
}

module.exports = cronTasks;
