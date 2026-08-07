const { Pool } = require('pg');
const config = require('../config');
const logger = require('../logs/logger');

class Database {
  constructor() {
    this.pool = new Pool({
      connectionString: config.database.url,
      ssl: config.database.url.includes('supabase.com') ? {
        rejectUnauthorized: false
      } : false,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 30000,
    });

    this.pool.on('connect', (client) => {
      client.query('SET search_path TO trading_ai, public').catch(err => {
        logger.error('Error setting search_path:', err);
      });
    });
  }

  async testConnection() {
    try {
      const result = await this.pool.query('SELECT NOW()');
      logger.info('Database connected successfully at:', result.rows[0].now);

      try {
        // Garantir BIGINT para preços e volumes
        await this.pool.query('ALTER TABLE trading_ai.scanner_snapshots ALTER COLUMN price TYPE BIGINT');
        await this.pool.query('ALTER TABLE trading_ai.scanner_snapshots ALTER COLUMN open TYPE BIGINT');
        await this.pool.query('ALTER TABLE trading_ai.scanner_snapshots ALTER COLUMN high TYPE BIGINT');
        await this.pool.query('ALTER TABLE trading_ai.scanner_snapshots ALTER COLUMN low TYPE BIGINT');
        await this.pool.query('ALTER TABLE trading_ai.scanner_snapshots ALTER COLUMN close TYPE BIGINT');
        await this.pool.query('ALTER TABLE trading_ai.scanner_snapshots ALTER COLUMN volume TYPE BIGINT');
        await this.pool.query('ALTER TABLE trading_ai.scanner_results ALTER COLUMN price TYPE BIGINT');
        await this.pool.query('ALTER TABLE trading_ai.scanner_results ALTER COLUMN volume TYPE BIGINT');

        // GARANTIR CONSTRAINT ÚNICA para o ON CONFLICT funcionar
        try {
          await this.pool.query(`
            ALTER TABLE trading_ai.scanner_snapshots
            ADD CONSTRAINT scanner_snapshots_unique_key UNIQUE (coin_id, timeframe, timestamp)
          `);
        } catch (e) {
          // Ignora se já existir
        }

        logger.info('Database migration: Scanner schema verified and price types set to BIGINT');
      } catch (err) {
        logger.error('Migration error (Scanner):', err.message);
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
        SELECT table_name, table_schema
        FROM information_schema.tables 
        WHERE table_schema IN ('public', 'trading_ai')
        ORDER BY table_schema, table_name;
      `);
      
      const tables = result.rows.map(row => `${row.table_schema}.${row.table_name}`);
      logger.info(`Found ${tables.length} tables in database (public & trading_ai)`);

      return tables;
    } catch (error) {
      logger.error('Error checking tables:', error);
      return [];
    }
  }

  async query(text, params) {
    const start = Date.now();
    try {
      // Se o banco está em read-only, bloqueamos INSERT/UPDATE, mas PERMITIMOS DELETE/TRUNCATE para limpeza
      const isWriteQuery = /INSERT|UPDATE|CREATE|ALTER|DROP/i.test(text);
      const isCleanupQuery = /DELETE|TRUNCATE|VACUUM/i.test(text);

      if (global.dbReadOnly && isWriteQuery && !isCleanupQuery) {
        return { rows: [], rowCount: 0 };
      }

      const result = await this.pool.query(text, params);
      const duration = Date.now() - start;
      return result;
    } catch (error) {
      if (error.message.includes('read-only')) {
        if (!global.dbReadOnly) {
          console.warn('!!! SCANNER DB: READ-ONLY MODE DETECTED !!!');
          global.dbReadOnly = true;
          // Tenta limpar imediatamente para destravar
          this.autoCleanup().catch(() => {});
        }
        return { rows: [], rowCount: 0 };
      }
      logger.error('Query error', { text, error: error.message });
      throw error;
    }
  }

  async autoCleanup() {
    try {
      logger.info('Running emergency cleanup for Scanner tables...');
      // Limpa os logs do scanner e snapshots brutos que são os mais pesados
      await this.pool.query('TRUNCATE TABLE trading_ai.logs CASCADE').catch(() => {});
      await this.pool.query("DELETE FROM trading_ai.scanner_snapshots WHERE timestamp < NOW() - INTERVAL '6 hours'");
      await this.pool.query('VACUUM ANALYZE').catch(() => {});

      global.dbReadOnly = false;
      logger.info('Scanner DB cleanup attempted.');
    } catch (e) {
      logger.error('Cleanup failed:', e.message);
    }
  }

  async getClient() {
    return await this.pool.connect();
  }

  async close() {
    await this.pool.end();
    logger.info('Database connection closed');
  }

  async autoCleanup() {
    try {
      logger.info('Running optimized database cleanup...');
      
      // Decisions > 7 days
      await this.pool.query("DELETE FROM trading_ai.ai_decisions WHERE timestamp < NOW() - INTERVAL '7 days'");
      
      // Logs > 3 days
      await this.pool.query("DELETE FROM trading_ai.ai_learning_logs WHERE timestamp < NOW() - INTERVAL '3 days'");
      
      // Snapshots > 1 day
      await this.pool.query("DELETE FROM trading_ai.scanner_snapshots WHERE timestamp < NOW() - INTERVAL '1 day'");

      // Indicators > 2 days
      const tables = ['ema', 'rsi', 'macd'];
      for (const t of tables) {
        await this.pool.query(`DELETE FROM trading_ai.${t} WHERE timestamp < NOW() - INTERVAL '2 days'`);
      }

      await this.pool.query('VACUUM ANALYZE');
      logger.info('Database cleanup completed');
      return true;
    } catch (error) {
      logger.error('Cleanup error:', error.message);
      return false;
    }
  }

  async checkSizeAndCleanup() {
    try {
      const result = await this.pool.query(`
        SELECT pg_database_size(current_database()) as size_bytes
      `);
      const sizeMB = result.rows[0].size_bytes / (1024 * 1024);
      logger.info(`Database size: ${sizeMB.toFixed(2)} MB`);

      if (sizeMB > 400) {
        await this.autoCleanup();
      }
      return sizeMB;
    } catch (error) {
      logger.error('Size check error:', error.message);
      return null;
    }
  }
}

module.exports = new Database();
