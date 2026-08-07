const cron = require('node-cron');
const queries = require('../database/queries.js');
const db = require('../database/connection.js');
const logger = require('../logs/logger.js');

const initCron = () => {
  // 1. Manutenção de Espaço (A cada 30 minutos)
  // Mantém o banco abaixo dos 512MB deletando logs desnecessários.
  cron.schedule('*/30 * * * *', async () => {
    try {
      logger.info('[CRON] Verificando integridade e espaço do banco...');
      await db.checkSizeAndCleanup();
    } catch (error) {
      logger.error('[CRON] Erro na manutenção de espaço:', error);
    }
  });

  // 2. Recalibragem Noturna (Diária às 03:00)
  // Além de limpar o banco, ela "poda" os pesos que não estão performando bem.
  cron.schedule('0 3 * * *', async () => {
    try {
      logger.info('[CRON] Iniciando Recalibragem Noturna...');
      
      // Faxina profunda
      await db.autoCleanup();
      
      // Sincroniza win rates e estatísticas de aprendizado
      const stats = await queries.getLiveStats();
      logger.info(`[CRON] IA consolidada: Win Rate Geral de ${(stats.win_rate * 100).toFixed(2)}%`);
      
    } catch (error) {
      logger.error('[CRON] Erro na recalibragem noturna:', error);
    }
  });

  // 3. Status de Aprendizado para o App (A cada 1 hora)
  cron.schedule('0 * * * *', async () => {
    if (global.dbReadOnly) return;
    try {
      const live = await queries.getLiveStats();
      logger.info(`[AI-STATS] Exemplos: ${live.ai_examples} | Simulações: ${live.total_simulated_ops} | Acertos: ${live.wins}`);
    } catch (e) { /* ignore */ }
  });

  logger.info('Master Cron inicializado: Otimizado para Aprendizado Eficiente');
};

module.exports = { initCron };
