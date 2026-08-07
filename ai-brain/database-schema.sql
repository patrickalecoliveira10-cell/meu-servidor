-- AI Brain V1.2.2 - Master Reset Final (Sniper Mode & Database Optimization)
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

-- 2. Operações Reais (Suporta Stop, Trailing e Parciais)
CREATE TABLE IF NOT EXISTS trading_ai.operations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    symbol VARCHAR(20) NOT NULL,
    side VARCHAR(10) NOT NULL,
    entry_price BIGINT NOT NULL, -- Preço * 10^10
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

-- 3. Tabelas de Aprendizado
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
  win_rate SMALLINT DEFAULT 0,
  avg_confidence SMALLINT DEFAULT 0,
  last_updated TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS trading_ai.ai_simulated_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coin_id VARCHAR(20) NOT NULL,
  timeframe VARCHAR(5) NOT NULL,
  entry_price BIGINT,
  exit_price BIGINT,
  result VARCHAR(10),
  confidence_at_entry SMALLINT,
  timestamp TIMESTAMP WITH TIME ZONE NOT NULL
);

INSERT INTO trading_ai.ai_global_learning (total_examples, win_rate, avg_confidence)
VALUES (0, 0, 0) ON CONFLICT DO NOTHING;
