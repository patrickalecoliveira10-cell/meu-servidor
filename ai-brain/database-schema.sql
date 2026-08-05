-- AI Brain V1.1 Database Schema (Trading AI Centralized)
-- Garantir o schema correto
CREATE SCHEMA IF NOT EXISTS trading_ai;
SET search_path TO trading_ai, public;

-- Extensões necessárias
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Tabela de Moedas
CREATE TABLE IF NOT EXISTS coins (
  id VARCHAR(20) PRIMARY KEY,
  symbol VARCHAR(20) UNIQUE NOT NULL,
  name VARCHAR(100),
  exchange VARCHAR(20) DEFAULT 'bybit',
  is_active BOOLEAN DEFAULT true,
  active BOOLEAN DEFAULT true,
  volume_24h BIGINT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Tabela de decisões da IA
CREATE TABLE IF NOT EXISTS ai_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coin_id VARCHAR(20) NOT NULL,
  timeframe VARCHAR(5) NOT NULL,
  decision VARCHAR(10) NOT NULL,
  side VARCHAR(10),
  price BIGINT,
  confidence SMALLINT,
  win_probability SMALLINT,
  loss_probability SMALLINT,
  risk SMALLINT,
  trend_strength SMALLINT,
  setup_quality SMALLINT,
  indicators_summary JSONB,
  timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
  FOREIGN KEY (coin_id) REFERENCES coins(id)
);

-- Tabela de pesos dos indicadores
CREATE TABLE IF NOT EXISTS ai_indicator_weights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coin_id VARCHAR(20),
  timeframe VARCHAR(5),
  indicator_name VARCHAR(50) NOT NULL,
  weight SMALLINT DEFAULT 100,
  performance_score SMALLINT DEFAULT 50,
  last_updated TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE (coin_id, timeframe, indicator_name)
);

-- Tabelas de aprendizado (Contadores como INTEGER para evitar overflow)
CREATE TABLE IF NOT EXISTS ai_global_learning (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  total_examples INTEGER DEFAULT 0,
  total_decisions INTEGER DEFAULT 0,
  correct_decisions INTEGER DEFAULT 0,
  win_rate SMALLINT DEFAULT 0,
  avg_confidence SMALLINT DEFAULT 0,
  patterns_learned JSONB DEFAULT '{}',
  last_updated TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ai_coin_learning (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coin_id VARCHAR(20) UNIQUE NOT NULL,
  total_examples INTEGER DEFAULT 0,
  total_decisions INTEGER DEFAULT 0,
  correct_decisions INTEGER DEFAULT 0,
  win_rate SMALLINT DEFAULT 0,
  avg_confidence SMALLINT DEFAULT 0,
  patterns_learned JSONB DEFAULT '{}',
  last_updated TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  FOREIGN KEY (coin_id) REFERENCES coins(id)
);

CREATE TABLE IF NOT EXISTS ai_timeframe_learning (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  timeframe VARCHAR(5) UNIQUE NOT NULL,
  total_examples INTEGER DEFAULT 0,
  total_decisions INTEGER DEFAULT 0,
  correct_decisions INTEGER DEFAULT 0,
  win_rate SMALLINT DEFAULT 0,
  avg_confidence SMALLINT DEFAULT 0,
  last_updated TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ai_daily_statistics (
  date DATE PRIMARY KEY,
  total_decisions INTEGER DEFAULT 0,
  correct_decisions INTEGER DEFAULT 0,
  win_rate SMALLINT DEFAULT 0,
  avg_confidence SMALLINT DEFAULT 0,
  operations_analyzed INTEGER DEFAULT 0,
  patterns_found SMALLINT DEFAULT 0,
  learning_updates SMALLINT DEFAULT 0,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Logs e Padrões
CREATE TABLE IF NOT EXISTS ai_learning_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  log_type VARCHAR(20),
  coin_id VARCHAR(20),
  timeframe VARCHAR(5),
  message TEXT,
  data JSONB,
  timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ai_market_patterns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern_name VARCHAR(50),
  coin_id VARCHAR(20),
  timeframe VARCHAR(5),
  pattern_type VARCHAR(20),
  success_rate SMALLINT DEFAULT 0,
  occurrence_count INTEGER DEFAULT 0,
  pattern_data JSONB,
  last_seen TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Gerenciamento e Simulação
CREATE TABLE IF NOT EXISTS ai_operation_management (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id UUID,
  coin_id VARCHAR(20) NOT NULL,
  timeframe VARCHAR(5) NOT NULL,
  current_price BIGINT,
  entry_price BIGINT,
  stop_loss BIGINT,
  take_profit BIGINT,
  decision VARCHAR(20),
  confidence SMALLINT,
  reason TEXT,
  partial_exit_percent SMALLINT,
  timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ai_simulated_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coin_id VARCHAR(20) NOT NULL,
  timeframe VARCHAR(5) NOT NULL,
  side VARCHAR(10),
  entry_price BIGINT,
  exit_price BIGINT,
  stop_loss BIGINT,
  take_profit BIGINT,
  result VARCHAR(10),
  profit_loss SMALLINT,
  duration_seconds INTEGER,
  confidence_at_entry SMALLINT,
  decision_data JSONB,
  timestamp TIMESTAMP WITH TIME ZONE NOT NULL
);

-- Configuração da IA
CREATE TABLE IF NOT EXISTS ai_configuration (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mode VARCHAR(15) NOT NULL DEFAULT 'observation',
  min_examples_for_operation INTEGER DEFAULT 1000,
  learning_rate SMALLINT DEFAULT 1,
  confidence_threshold SMALLINT DEFAULT 70,
  max_operations_per_day SMALLINT DEFAULT 10,
  current_examples_count INTEGER DEFAULT 0,
  is_operational BOOLEAN DEFAULT false,
  last_updated TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Tabelas do Scanner
CREATE TABLE IF NOT EXISTS scanner_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coin_id VARCHAR(20) NOT NULL,
  timeframe VARCHAR(5) NOT NULL,
  price BIGINT,
  volume BIGINT,
  open BIGINT,
  high BIGINT,
  low BIGINT,
  close BIGINT,
  indicators JSONB,
  timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(coin_id, timeframe, timestamp)
);

CREATE TABLE IF NOT EXISTS scanner_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID,
  coin_id VARCHAR(20) NOT NULL,
  timeframe VARCHAR(5) NOT NULL,
  score SMALLINT,
  price BIGINT,
  volume BIGINT,
  volatility SMALLINT,
  indicators_matched JSONB,
  indicators_summary JSONB,
  timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  FOREIGN KEY (coin_id) REFERENCES coins(id)
);

CREATE TABLE IF NOT EXISTS scanner_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status VARCHAR(20),
  coins_count INTEGER,
  coins_scanned INTEGER DEFAULT 0,
  snapshots_created INTEGER DEFAULT 0,
  errors_count INTEGER DEFAULT 0,
  duration_seconds INTEGER DEFAULT 0,
  timeframes JSONB,
  start_time TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  end_time TIMESTAMP WITH TIME ZONE
);

-- Tabelas de Indicadores (Genéricas)
CREATE TABLE IF NOT EXISTS indicator_ema (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coin_id VARCHAR(20) NOT NULL,
  timeframe VARCHAR(5) NOT NULL,
  period INTEGER,
  value BIGINT,
  timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(coin_id, timeframe, period, timestamp)
);

CREATE TABLE IF NOT EXISTS indicator_rsi (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coin_id VARCHAR(20) NOT NULL,
  timeframe VARCHAR(5) NOT NULL,
  period INTEGER,
  value BIGINT,
  timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(coin_id, timeframe, period, timestamp)
);

CREATE TABLE IF NOT EXISTS indicator_macd (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coin_id VARCHAR(20) NOT NULL,
  timeframe VARCHAR(5) NOT NULL,
  period INTEGER,
  value BIGINT,
  timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(coin_id, timeframe, period, timestamp)
);

-- Índices essenciais
CREATE INDEX IF NOT EXISTS idx_ai_decisions_timestamp ON ai_decisions(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_scanner_snapshots_timestamp ON scanner_snapshots(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_scanner_results_timestamp ON scanner_results(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_ai_simulated_ops_timestamp ON ai_simulated_operations(timestamp DESC);

-- Dados Iniciais
INSERT INTO ai_configuration (mode, min_examples_for_operation, learning_rate, confidence_threshold, max_operations_per_day)
VALUES ('observation', 1000, 1, 70, 20) ON CONFLICT DO NOTHING;

INSERT INTO ai_global_learning (total_examples, win_rate)
VALUES (0, 0) ON CONFLICT DO NOTHING;
