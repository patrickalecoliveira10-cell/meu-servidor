const cron = require('node-cron');
const db = require('../database/connection'); // Caminho corrigido para o Render
const logger = require('../logs/logger');

const initCron = () => {
    // 1. Manutenção de Espaço (A cada 30 minutos - Previne estouro de 512MB)
    cron.schedule('*/30 * * * *', async () => {
        try {
            logger.info('[CRON] Higienizando Supabase para manter Sniper 24h...');
            
            // Remove logs com mais de 3 dias
            await db.query("DELETE FROM trading_ai.logs WHERE timestamp < NOW() - INTERVAL '3 days'");
            
            // Remove simulações de Loss com baixa confiança
            await db.query("DELETE FROM trading_ai.ai_simulated_operations WHERE confidence_at_entry < 50 AND result = 'loss'");
            
            // Mantém apenas o top 3000 registros para evitar o limite do Supabase
            await db.query(`
                DELETE FROM trading_ai.ai_simulated_operations 
                WHERE id NOT IN (
                    SELECT id FROM trading_ai.ai_simulated_operations 
                    ORDER BY timestamp DESC LIMIT 3000
                )
            `);
            
            // Libera o espaço em disco de fato
            await db.query('VACUUM ANALYZE');
            
            logger.info('[CRON] Banco de dados otimizado.');
        } catch (error) {
            logger.error('[CRON] Erro na manutenção:', error.message);
        }
    });

    // 2. Heartbeat Keep-Alive (A cada 5 minutos - Mantém o Render acordado)
    cron.schedule('*/5 * * * *', async () => {
        try {
            await db.query('SELECT 1');
        } catch (e) {
            logger.error('[HEARTBEAT] Falha ao manter servidor ativo:', e.message);
        }
    });

    logger.info('>>> Monitoramento Sniper 24h e Auto-Cleanup Ativado.');
};

module.exports = { initCron };
