-- AI Brain V1.2.2 - Master Reset (Otimizado para Aprendizado Sniper e Supabase 512MB)
CREATE SCHEMA IF NOT EXISTS trading_ai;
SET search_path TO trading_ai, public;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Logs do Sistema (Auto-cleanup via cron.js)
CREATE TABLE IF NOT EXISTS trading_ai.logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  level VARCHAR(10),
  message TEXT,
  context JSONB,
  source VARCHAR(50),
  timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. Moedas
CREATE TABLE IF NOT EXISTS trading_ai.coins (
  id VARCHAR(20) PRIMARY KEY,
  symbol VARCHAR(20) UNIQUE NOT NULL,
  name VARCHAR(100),
  exchange VARCHAR(20) DEFAULT 'bybit',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Pesos dos Indicadores (O "Cérebro" da IA)
CREATE TABLE IF NOT EXISTS trading_ai.ai_indicator_weights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  indicator_name VARCHAR(50) NOT NULL,
  coin_id VARCHAR(20) DEFAULT 'GLOBAL',
  timeframe VARCHAR(10) DEFAULT 'ALL',
  weight SMALLINT DEFAULT 50,
  performance_score SMALLINT DEFAULT 50,
  last_updated TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(indicator_name, coin_id, timeframe)
);

-- 4. Operações (Preços escalados por 10^10 em BIGINT)
CREATE TABLE IF NOT EXISTS trading_ai.operations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    symbol VARCHAR(20) NOT NULL,
    side VARCHAR(10) NOT NULL,
    entry_price BIGINT NOT NULL,
    exit_price BIGINT,
    stop_loss BIGINT,
    take_profit BIGINT,
    trailing_stop BIGINT,
    status VARCHAR(20) NOT NULL DEFAULT 'OPEN',
    profit_loss SMALLINT,
    partial_exit_done BOOLEAN DEFAULT FALSE,
    partial_entry_count INTEGER DEFAULT 0,
    last_analysis TEXT,
    opened_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    close_time TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS trading_ai.ai_simulated_operations (
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
  confidence_at_entry SMALLINT,
  duration_seconds INTEGER,
  decision_data JSONB,
  timestamp TIMESTAMP WITH TIME ZONE NOT NULL
);

-- 5. Tabelas de Aprendizado (Contadores INTEGER para evitar overflow)
CREATE TABLE IF NOT EXISTS trading_ai.ai_coin_learning (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coin_id VARCHAR(20) UNIQUE NOT NULL,
  total_examples INTEGER DEFAULT 0,
  total_decisions INTEGER DEFAULT 0,
  correct_decisions INTEGER DEFAULT 0,
  win_rate SMALLINT DEFAULT 0,
  avg_confidence SMALLINT DEFAULT 0,
  last_updated TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS trading_ai.ai_global_learning (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  total_examples INTEGER DEFAULT 0,
  total_decisions INTEGER DEFAULT 0,
  correct_decisions INTEGER DEFAULT 0,
  win_rate SMALLINT DEFAULT 0,
  avg_confidence SMALLINT DEFAULT 0,
  last_updated TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS trading_ai.ai_patterns (
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
);

-- Scanner Sessions
CREATE TABLE IF NOT EXISTS trading_ai.scanner_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status VARCHAR(20) DEFAULT 'running',
  coins_count INTEGER DEFAULT 0,
  timeframes TEXT,
  start_time TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  end_time TIMESTAMP WITH TIME ZONE
);

-- Scanner Results
CREATE TABLE IF NOT EXISTS trading_ai.scanner_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES trading_ai.scanner_sessions(id) ON DELETE CASCADE,
  coin_id VARCHAR(20) NOT NULL,
  timeframe VARCHAR(10) NOT NULL,
  score NUMERIC,
  price NUMERIC,
  volume NUMERIC,
  volatility NUMERIC,
  indicators_matched TEXT,
  timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Dados Iniciais
INSERT INTO trading_ai.ai_global_learning (total_examples, win_rate, avg_confidence)
VALUES (0, 0, 0) ON CONFLICT DO NOTHING;
