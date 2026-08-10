const db = require('./connection');
const logger = require('../logs/logger');

const cronTasks = {
    async runDailyCleanup() {
        try {
            logger.info('[CRON] Iniciando limpeza AGRESSIVA para economia de Bandwidth...');

            // 1. Remove logs com mais de 24h (Logs ocupam muita banda de consulta)
            await db.query("DELETE FROM trading_ai.logs WHERE timestamp < NOW() - INTERVAL '1 day'");

            // 2. Remove resultados antigos do scanner (O App só precisa dos preços atuais)
            // Isso evita que a tabela scanner_results cresça infinitamente
            await db.query("DELETE FROM trading_ai.scanner_results WHERE timestamp < NOW() - INTERVAL '12 hours'");

            // 3. Remove simulações de "Loss" com mais de 6 horas
            // Mantemos os "Wins" para aprendizado, mas deletamos perdas antigas para poupar espaço
            await db.query("DELETE FROM trading_ai.ai_simulated_operations WHERE result = 'loss' AND timestamp < NOW() - INTERVAL '6 hours'");

            // 4. Executa VACUUM para recuperar espaço em disco fisicamente e liberar a trava do Supabase
            await db.query('VACUUM ANALYZE');

            logger.info('[CRON] Higienização completa. Bandwidth preservada.');
        } catch (e) {
            logger.error('[CRON] Falha na limpeza:', e.message);
        }
    },

    // Mantém o servidor do Render ativo
    async keepAlive() {
        try {
            await db.query('SELECT 1');
        } catch (e) {}
    }
};

// Agendar tarefas
if (process.env.NODE_ENV !== 'test') {
    // Aumentamos a frequência para CADA 1 HORA para não acumular lixo no banco
    setInterval(() => cronTasks.runDailyCleanup(), 1 * 60 * 60 * 1000); 
    setInterval(() => cronTasks.keepAlive(), 5 * 60 * 1000); 
}

module.exports = cronTasks;
