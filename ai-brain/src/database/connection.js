const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const config = require(path.join(__dirname, '../config/index.js'));
const logger = require(path.join(__dirname, '../logs/logger.js'));

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

    this.pool.on('error', (err) => {
      logger.error('Unexpected error on idle client', err);
      process.exit(-1);
    });

    // Configura o search_path para priorizar o schema trading_ai
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
      return true;
    } catch (error) {
      logger.error('Database connection error:', error);
      return false;
    }
  }

  async initSchema() {
    try {
      const schemaPath = path.join(__dirname, '../../database-schema.sql');
      logger.info(`Schema lookup at: ${schemaPath}`);

      if (fs.existsSync(schemaPath)) {
        const sql = fs.readFileSync(schemaPath, 'utf8');
        logger.info('SQL script loaded, executing schema sync...');

        // Dividir em comandos para melhor controle de erro
        const commands = sql.split(';').filter(cmd => cmd.trim() !== '');
        for (let cmd of commands) {
          try {
            await this.pool.query(cmd);
          } catch (e) {
            // Ignorar erros de "já existe", mas logar outros
            if (!e.message.includes('already exists')) {
              logger.debug(`Schema notice: ${e.message}`);
            }
          }
        }

        // --- FINAL MIGRATIONS (Garantir colunas novas e tipos corretos) ---
        const migrations = [
          "CREATE SCHEMA IF NOT EXISTS trading_ai",
          // Ajuste de tipos para BIGINT (prevenir overflow de preço)
          "ALTER TABLE trading_ai.ai_decisions ALTER COLUMN price TYPE BIGINT",
          "ALTER TABLE trading_ai.ai_simulated_operations ALTER COLUMN entry_price TYPE BIGINT",
          "ALTER TABLE trading_ai.ai_simulated_operations ALTER COLUMN exit_price TYPE BIGINT",
          "ALTER TABLE trading_ai.ai_simulated_operations ALTER COLUMN stop_loss TYPE BIGINT",
          "ALTER TABLE trading_ai.ai_simulated_operations ALTER COLUMN take_profit TYPE BIGINT",
          "ALTER TABLE trading_ai.scanner_snapshots ALTER COLUMN price TYPE BIGINT",
          "ALTER TABLE trading_ai.scanner_snapshots ALTER COLUMN open TYPE BIGINT",
          "ALTER TABLE trading_ai.scanner_snapshots ALTER COLUMN high TYPE BIGINT",
          "ALTER TABLE trading_ai.scanner_snapshots ALTER COLUMN low TYPE BIGINT",
          "ALTER TABLE trading_ai.scanner_snapshots ALTER COLUMN close TYPE BIGINT",

          // Fix SMALLINT limits for learning counters
          "ALTER TABLE trading_ai.ai_global_learning ALTER COLUMN total_examples TYPE INTEGER",
          "ALTER TABLE trading_ai.ai_global_learning ALTER COLUMN total_decisions TYPE INTEGER",
          "ALTER TABLE trading_ai.ai_global_learning ALTER COLUMN correct_decisions TYPE INTEGER",
          "ALTER TABLE trading_ai.ai_coin_learning ALTER COLUMN total_examples TYPE INTEGER",
          "ALTER TABLE trading_ai.ai_coin_learning ALTER COLUMN total_decisions TYPE INTEGER",
          "ALTER TABLE trading_ai.ai_coin_learning ALTER COLUMN correct_decisions TYPE INTEGER",

          // Novas Tabelas Learning (se falhou no script principal)
          "ALTER TABLE trading_ai.ai_timeframe_learning ALTER COLUMN total_examples TYPE INTEGER",
          "ALTER TABLE trading_ai.ai_timeframe_learning ALTER COLUMN total_decisions TYPE INTEGER",
          "ALTER TABLE trading_ai.ai_timeframe_learning ALTER COLUMN correct_decisions TYPE INTEGER",
          "ALTER TABLE trading_ai.ai_daily_statistics ALTER COLUMN total_decisions TYPE INTEGER",
          "ALTER TABLE trading_ai.ai_daily_statistics ALTER COLUMN correct_decisions TYPE INTEGER",
          "ALTER TABLE trading_ai.ai_daily_statistics ALTER COLUMN operations_analyzed TYPE INTEGER",

          // Executor Management Preços
          "ALTER TABLE trading_ai.ai_operation_management ALTER COLUMN current_price TYPE BIGINT",
          "ALTER TABLE trading_ai.ai_operation_management ALTER COLUMN entry_price TYPE BIGINT",
          "ALTER TABLE trading_ai.ai_operation_management ALTER COLUMN stop_loss TYPE BIGINT",
          "ALTER TABLE trading_ai.ai_operation_management ALTER COLUMN take_profit TYPE BIGINT",

          // Tabela market_snapshots legada para scanner_snapshots
          "DROP TABLE IF EXISTS trading_ai.market_snapshots CASCADE",

          // Novas tabelas para o módulo Learning
          `CREATE TABLE IF NOT EXISTS trading_ai.ai_patterns (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            pattern_name VARCHAR(100) NOT NULL,
            coin_id VARCHAR(20),
            timeframe VARCHAR(10),
            pattern_type VARCHAR(20),
            success_rate SMALLINT,
            occurrence_count INTEGER DEFAULT 1,
            pattern_data JSONB,
            last_seen TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            UNIQUE(pattern_name, coin_id)
          )`,
          `CREATE TABLE IF NOT EXISTS trading_ai.ai_learning_logs (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            log_type VARCHAR(50),
            coin_id VARCHAR(20),
            message TEXT,
            data JSONB,
            timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW()
          )`
        ];

        for (const migration of migrations) {
          try {
            await this.pool.query(migration);
          } catch (e) {
            logger.debug(`Migration skip/notice: ${e.message}`);
          }
        }

        // --- MIGRATION: OPERATIONS TABLE ---
        try {
            await this.pool.query(`
                CREATE TABLE IF NOT EXISTS trading_ai.operations (
                    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    symbol VARCHAR(20) NOT NULL,
                    side VARCHAR(10) NOT NULL,
                    entry_price BIGINT NOT NULL,
                    exit_price BIGINT,
                    stop_loss BIGINT,
                    take_profit BIGINT,
                    trailing_stop INTEGER,
                    status VARCHAR(20) NOT NULL DEFAULT 'OPEN',
                    partial_exit_done BOOLEAN DEFAULT FALSE,
                    partial_entry_count INTEGER DEFAULT 0,
                    last_analysis TEXT,
                    opened_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                    close_time TIMESTAMP WITH TIME ZONE,
                    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
                );
            `);

            // Garantir colunas para gestão dinâmica
            const dynamicCols = [
                "ALTER TABLE trading_ai.operations ADD COLUMN IF NOT EXISTS trailing_stop INTEGER",
                "ALTER TABLE trading_ai.operations ADD COLUMN IF NOT EXISTS partial_exit_done BOOLEAN DEFAULT FALSE",
                "ALTER TABLE trading_ai.operations ADD COLUMN IF NOT EXISTS partial_entry_count INTEGER DEFAULT 0",
                "ALTER TABLE trading_ai.operations ADD COLUMN IF NOT EXISTS last_analysis TEXT"
            ];

            for (const colQuery of dynamicCols) {
                await this.pool.query(colQuery).catch(() => {});
            }
        } catch (e) {
            logger.error('Error creating/updating operations table:', e.message);
        }

        logger.info('Database schema synchronization and migrations finished.');
      } else {
        logger.error(`CRITICAL: Schema file MISSING at ${schemaPath}`);
        // Se o arquivo não existir, criar pelo menos a tabela crítica para o boot não falhar
        await this.pool.query('CREATE SCHEMA IF NOT EXISTS trading_ai');
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS trading_ai.ai_indicator_weights (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            indicator_name VARCHAR(50) NOT NULL,
            coin_id VARCHAR(20),
            timeframe VARCHAR(10),
            weight SMALLINT DEFAULT 100,
            UNIQUE(indicator_name, coin_id, timeframe)
          );
        `);
      }
    } catch (error) {
      logger.error('Failed to initialize schema:', error);
    }
  }

  async checkTables() {
    try {
      const result = await this.pool.query(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema IN ('public', 'trading_ai')
        ORDER BY table_name;
      `);
      const tables = result.rows.map(row => row.table_name);
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
    return await this.pool.connect();
  }

  async close() {
    await this.pool.end();
  }
}

module.exports = new Database();
