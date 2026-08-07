const cron = require('node-cron');
const queries = require('../database/queries.js');
const db = require('../database/connection.js');
const logger = require('../logs/logger.js');

const initCron = () => {
  // Limpeza de manutenção do banco (Cada 1 hora para evitar estouro de 512MB)
  cron.schedule('0 * * * *', async () => {
    try {
      logger.info('[CRON] Verificando tamanho do banco de dados para manutenção...');
      await db.checkSizeAndCleanup();
    } catch (error) {
      logger.error('[CRON] Erro na tarefa de limpeza agendada:', error);
    }
  });

  // Limpeza profunda diária (Às 03:00) para garantir espaço livre
  cron.schedule('0 3 * * *', async () => {
    try {
      logger.info('[CRON] Iniciando limpeza profunda diária (TRUNCATE logs)...');
      await db.autoCleanup();
    } catch (error) {
      logger.error('[CRON] Erro na limpeza profunda:', error);
    }
  });

  // Atualizar estatísticas diárias todos os dias às 23:55
  cron.schedule('55 23 * * *', async () => {
    if (global.dbReadOnly) {
      logger.warn('[CRON] Banco em modo Read-Only. Pulando atualização de estatísticas.');
      return;
    }
    try {
      logger.info('Running daily statistics update...');
      const today = new Date().toISOString().split('T')[0];

      // Coletar dados do dia
      const decisions = await queries.getRecentDecisions(1000); // Simplificado
      const todayDecisions = decisions.filter(d =>
        new Date(d.timestamp).toISOString().split('T')[0] === today
      );

      const stats = {
        date: today,
        total_decisions: todayDecisions.length,
        correct_decisions: todayDecisions.filter(d => d.win_probability > 0.7).length, // Placeholder logic
        win_rate: todayDecisions.length > 0 ? (todayDecisions.filter(d => d.win_probability > 0.7).length / todayDecisions.length) : 0,
        avg_confidence: todayDecisions.length > 0 ? todayDecisions.reduce((acc, d) => acc + parseFloat(d.confidence), 0) / todayDecisions.length : 0,
        operations_analyzed: todayDecisions.length,
        patterns_found: 0,
        learning_updates: 0
      };

      await queries.updateDailyStatistics(stats);
      logger.info('Daily statistics updated successfully');
    } catch (error) {
      logger.error('Error in daily cron task:', error);
    }
  });

  logger.info('Cron jobs initialized');
};

module.exports = { initCron };
