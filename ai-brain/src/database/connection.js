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

          // Fix unique constraint for ai_indicator_weights - use simple UNIQUE constraint
          "DROP TABLE IF EXISTS trading_ai.ai_indicator_weights CASCADE",
          `CREATE TABLE IF NOT EXISTS trading_ai.ai_indicator_weights (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            indicator_name VARCHAR(50) NOT NULL,
            coin_id VARCHAR(20) DEFAULT 'GLOBAL',
            timeframe VARCHAR(10) DEFAULT 'ALL',
            weight SMALLINT DEFAULT 100,
            performance_score SMALLINT DEFAULT 50,
            last_updated TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            UNIQUE(indicator_name, coin_id, timeframe)
          )`,
          // Fix SMALLINT overflow for learning counters - handle existing overflow data first
          "UPDATE trading_ai.ai_coin_learning SET total_examples = 32767 WHERE total_examples > 32767 OR total_examples IS NULL",
          "UPDATE trading_ai.ai_global_learning SET total_examples = 32767 WHERE total_examples > 32767 OR total_examples IS NULL",
          "UPDATE trading_ai.ai_coin_learning SET total_decisions = 32767 WHERE total_decisions > 32767 OR total_decisions IS NULL",
          "UPDATE trading_ai.ai_global_learning SET total_decisions = 32767 WHERE total_decisions > 32767 OR total_decisions IS NULL",
          "UPDATE trading_ai.ai_coin_learning SET correct_decisions = 32767 WHERE correct_decisions > 32767 OR correct_decisions IS NULL",
          "UPDATE trading_ai.ai_global_learning SET correct_decisions = 32767 WHERE correct_decisions > 32767 OR correct_decisions IS NULL",
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
      // Se detectamos que o banco está em read-only, evitamos comandos de modificação
      const isWriteQuery = /INSERT|UPDATE|DELETE|CREATE|ALTER|DROP/i.test(text);
      if (global.dbReadOnly && isWriteQuery) {
        return { rows: [], rowCount: 0 };
      }

      const result = await this.pool.query(text, params);
      const duration = Date.now() - start;
      logger.debug('Executed query', { text, duration, rows: result.rowCount });
      return result;
    } catch (error) {
      if (error.message.includes('read-only')) {
        if (!global.dbReadOnly) {
          logger.warn('!!! DATABASE ENTERED READ-ONLY MODE - WRITES DISABLED !!!');
          global.dbReadOnly = true;
        }
        return { rows: [], rowCount: 0 };
      } else {
        logger.error('Query error', { text, error: error.message });
        throw error;
      }
    }
  }

  async getClient() {
    return await this.pool.connect();
  }

  // Sistema de limpeza automática para manter o banco abaixo de 512MB
  async autoCleanup() {
    try {
      logger.info('Iniciando limpeza automática do banco de dados (Limite 512MB)...');

      // 1. LIMPEZA DE LOGS (Ocupam muito espaço e são pouco úteis para a IA)
      await this.pool.query("DELETE FROM trading_ai.logs WHERE timestamp < NOW() - INTERVAL '3 days'");
      await this.pool.query("DELETE FROM trading_ai.ai_learning_logs WHERE timestamp < NOW() - INTERVAL '7 days'");
      logger.info('Logs antigos removidos.');

      // 2. SNAPSHOTS DO SCANNER (Dados brutos, manter apenas o necessário para análise recente)
      await this.pool.query("DELETE FROM trading_ai.scanner_snapshots WHERE timestamp < NOW() - INTERVAL '1 day'");
      logger.info('Snapshots brutos antigos removidos.');

      // 3. DECISÕES DA IA (Manter histórico importante, mas limpar o excesso)
      // Mantemos decisões de 'enter' por mais tempo, 'observe' limpamos rápido
      await this.pool.query("DELETE FROM trading_ai.ai_decisions WHERE decision = 'observe' AND timestamp < NOW() - INTERVAL '2 days'");
      await this.pool.query("DELETE FROM trading_ai.ai_decisions WHERE timestamp < NOW() - INTERVAL '15 days'");
      logger.info('Decisões de IA otimizadas.');

      // 4. OPERAÇÕES SIMULADAS (Manter apenas os últimos 30 dias de performance)
      await this.pool.query("DELETE FROM trading_ai.ai_simulated_operations WHERE timestamp < NOW() - INTERVAL '30 days'");

      // 5. VACUUM (Essencial para o Postgres liberar o espaço em disco de fato)
      // Nota: VACUUM FULL trava as tabelas, usamos apenas VACUUM ANALYZE por segurança em produção
      await this.pool.query('VACUUM ANALYZE');

      global.dbReadOnly = false; // Tenta destravar o modo read-only após a limpeza
      logger.info('Limpeza concluída com sucesso.');
      return true;
    } catch (error) {
      logger.error('Erro na limpeza automática:', error.message);
      return false;
    }
  }

  async checkSizeAndCleanup() {
    try {
      const result = await this.pool.query(`
        SELECT pg_database_size(current_database()) as size_bytes
      `);
      const sizeMB = result.rows[0].size_bytes / (1024 * 1024);
      logger.info(`Tamanho atual do banco: ${sizeMB.toFixed(2)} MB`);

      // Se passar de 400MB (segurança para o limite de 512MB), limpa.
      if (sizeMB > 400 || global.dbReadOnly) {
        logger.warn(`Banco atingindo limite (${sizeMB.toFixed(2)}MB). Executando autoCleanup...`);
        await this.autoCleanup();
      }
    } catch (e) {
      logger.error('Erro ao verificar tamanho do banco:', e.message);
    }
  }

  async close() {
    await this.pool.end();
  }
}

module.exports = new Database();
