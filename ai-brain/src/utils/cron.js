const cron = require('node-cron');
const queries = require('../database/queries.js');
const db = require('../database/connection.js');
const logger = require('../logs/logger.js');

const initCron = () => {
  // 1. Manutenção de Espaço (A cada 30 minutos)
  // Essencial para manter o aprendizado eficiente sem estourar o limite de 512MB
  cron.schedule('*/30 * * * *', async () => {
    try {
      const isReadOnly = global.dbReadOnly;
      logger.info(`[CRON] Verificando integridade do banco (Status Read-Only: ${isReadOnly})`);

      // Se estiver travado ou perto do limite, executa auto-cura
      await db.checkSizeAndCleanup();
    } catch (error) {
      logger.error('[CRON] Erro na manutenção de espaço:', error);
    }
  });

  // 2. Limpeza de rastro (Diária às 03:00)
  // Remove logs e snapshots antigos, preservando apenas o conhecimento da IA
  cron.schedule('0 3 * * *', async () => {
    try {
      logger.info('[CRON] Iniciando faxina diária para otimizar aprendizado...');
      await db.autoCleanup();
    } catch (error) {
      logger.error('[CRON] Erro na faxina diária:', error);
    }
  });

  // 3. Atualizar estatísticas de performance (Diário às 23:55)
  cron.schedule('55 23 * * *', async () => {
    if (global.dbReadOnly) return;
    try {
      logger.info('[CRON] Sincronizando estatísticas de aprendizado...');
      const today = new Date().toISOString().split('T')[0];
      const stats = {
        date: today,
        learning_updates: 1, // Indica que houve um ciclo de aprendizado
        // Outros campos serão calculados pela query
      };
      await queries.updateDailyStatistics?.(stats);
    } catch (error) {
      logger.error('[CRON] Erro ao atualizar estatísticas:', error);
    }
  });

  logger.info('Sistema de manutenção (CRON) otimizado para Aprendizado Eficiente');
};

module.exports = { initCron };
