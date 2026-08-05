const { Pool } = require('pg');
const config = require('../config');
const logger = require('../logger');

class Database {
  constructor() {
    this.pool = new Pool({
      connectionString: config.database.url,
      ssl: config.database.url.includes('supabase.com') ? {
        rejectUnauthorized: false
      } : false,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 30000, // Aumentado para 30s para evitar timeout no Render
    });

    this.pool.on('error', (err) => {
      logger.error('Unexpected error on idle client', err);
      process.exit(-1);
    });

    // Configura o search_path para priorizar o schema trading_ai
    this.pool.on('connect', (client) => {
      client.query('SET search_path TO trading_ai, public');
    });
  }

  async testConnection() {
    try {
      const result = await this.pool.query('SELECT NOW()');
      logger.info('Database connected successfully at:', result.rows[0].now);

      // MIGRATIONS: Garantir BIGINT para colunas de preço no Executor
      try {
        await this.pool.query('ALTER TABLE trading_ai.ai_operation_management ALTER COLUMN current_price TYPE BIGINT');
        await this.pool.query('ALTER TABLE trading_ai.ai_operation_management ALTER COLUMN entry_price TYPE BIGINT');
        await this.pool.query('ALTER TABLE trading_ai.ai_operation_management ALTER COLUMN stop_loss TYPE BIGINT');
        await this.pool.query('ALTER TABLE trading_ai.ai_operation_management ALTER COLUMN take_profit TYPE BIGINT');
        logger.info('Database migration: Executor management columns set to BIGINT');
      } catch (err) {
        logger.debug('Migration notice (Executor): ' + err.message);
      }

      return true;
    } catch (error) {
      logger.error('Database connection error:', error);
      return false;
    }
  }

  async checkTables() {
    try {
      const result = await this.pool.query(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'trading_ai'
        ORDER BY table_name;
      `);
      
      const tables = result.rows.map(row => row.table_name);
      logger.info(`Found ${tables.length} tables in trading_ai schema`);
      return tables;
    } catch (error) {
      logger.error('Error checking tables:', error);
      return [];
    }
  }

  async query(text, params) {
    const start = Date.now();
    try {
      const result = await this.pool.query(text, params);
      const duration = Date.now() - start;
      logger.debug('Executed query', { text, duration, rows: result.rowCount });
      return result;
    } catch (error) {
      logger.error('Query error', { text, error: error.message });
      throw error;
    }
  }

  async getClient() {
    const client = await this.pool.connect();
    return client;
  }

  async close() {
    await this.pool.end();
    logger.info('Database connection closed');
  }

  // Sistema de limpeza automática otimizado para 512MB - Foco em dados lucrativos
  async autoCleanup() {
    try {
      logger.info('Running optimized database cleanup for 512MB limit...');

      // ESTRATÉGIA: Manter dados críticos para IA, reduzir dados brutos do Scanner

      // 1. DADOS CRÍTICOS DA IA
      // Limpar decisões antigas (manter 7 dias)
      await this.pool.query(`
        DELETE FROM trading_ai.ai_decisions 
        WHERE timestamp < NOW() - INTERVAL '7 days'
      `);
      logger.info(`Cleaned old AI decisions`);

      // 2. DADOS DO SCANNER (Maior consumo de espaço)
      // Snapshots - manter apenas 1 dia
      await this.pool.query(`
        DELETE FROM trading_ai.scanner_snapshots
        WHERE timestamp < NOW() - INTERVAL '1 day'
      `);
      logger.info(`Cleaned old scanner snapshots`);

      // Indicadores - manter apenas 2 dias
      const indicatorTables = [
        'trading_ai.indicator_ema', 'trading_ai.indicator_rsi', 'trading_ai.indicator_macd'
      ];
      
      for (const table of indicatorTables) {
        try {
          await this.pool.query(`DELETE FROM ${table} WHERE timestamp < NOW() - INTERVAL '2 days'`);
        } catch (err) {
          logger.warn(`Could not clean table ${table}: ${err.message}`);
        }
      }
      logger.info(`Cleaned old indicators`);

      // Resultados do Scanner - manter 3 dias
      await this.pool.query(`
        DELETE FROM trading_ai.scanner_results 
        WHERE timestamp < NOW() - INTERVAL '3 days'
      `);

      // 3. ESTATÍSTICAS
      // Manter estatísticas por 30 dias
      await this.pool.query(`
        DELETE FROM trading_ai.executor_statistics
        WHERE timestamp < NOW() - INTERVAL '30 days'
      `);

      // 4. VACUUM AGRESSIVO para liberar espaço imediatamente
      logger.info('Running VACUUM ANALYZE to reclaim space...');
      await this.pool.query('VACUUM ANALYZE');

      logger.info('Optimized database cleanup completed successfully');
      return true;
    } catch (error) {
      logger.error('Error during optimized cleanup:', error.message);
      return false;
    }
  }

  // Verificar tamanho do banco e limpar se necessário
  async checkSizeAndCleanup() {
    try {
      const result = await this.pool.query(`
        SELECT pg_size_pretty(pg_database_size(current_database())) as size,
               pg_database_size(current_database()) as size_bytes
      `);

      const sizeBytes = result.rows[0].size_bytes;
      const sizeMB = sizeBytes / (1024 * 1024);
      const maxSizeMB = 400; // Limite de segurança agressivo (400MB de 512MB)

      logger.info(`Current database size: ${result.rows[0].size} (${sizeMB.toFixed(2)} MB)`);

      if (sizeMB > maxSizeMB) {
        logger.warn(`Database size exceeds ${maxSizeMB}MB limit. Running cleanup...`);
        await this.autoCleanup();
      }

      return { size: result.rows[0].size, sizeMB };
    } catch (error) {
      logger.error('Error checking database size:', error.message);
      return null;
    }
  }
}

module.exports = new Database();
