-- Fix for Server 2 Database Errors
-- This script creates all AI tables in the trading_ai schema and fixes column types

-- Create trading_ai schema if it doesn't exist
CREATE SCHEMA IF NOT EXISTS trading_ai;

-- Create ai_decisions table in trading_ai schema
CREATE TABLE IF NOT EXISTS trading_ai.ai_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coin_id VARCHAR(20) NOT NULL,
  timeframe VARCHAR(5) NOT NULL,
  decision VARCHAR(10) NOT NULL,
  confidence SMALLINT,
  win_probability SMALLINT,
  loss_probability SMALLINT,
  risk SMALLINT,
  trend_strength SMALLINT,
  setup_quality SMALLINT,
  indicators_summary JSONB,
  timestamp TIMESTAMP WITH TIME ZONE NOT NULL
);

-- Add missing columns if table already exists (check both schemas)
DO $$
BEGIN
  -- Check and fix in trading_ai schema
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'trading_ai' AND table_name = 'ai_decisions') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'trading_ai' AND table_name = 'ai_decisions' AND column_name = 'trend_strength') THEN
      ALTER TABLE trading_ai.ai_decisions ADD COLUMN trend_strength SMALLINT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'trading_ai' AND table_name = 'ai_decisions' AND column_name = 'setup_quality') THEN
      ALTER TABLE trading_ai.ai_decisions ADD COLUMN setup_quality SMALLINT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'trading_ai' AND table_name = 'ai_decisions' AND column_name = 'risk') THEN
      ALTER TABLE trading_ai.ai_decisions ADD COLUMN risk SMALLINT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'trading_ai' AND table_name = 'ai_decisions' AND column_name = 'loss_probability') THEN
      ALTER TABLE trading_ai.ai_decisions ADD COLUMN loss_probability SMALLINT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'trading_ai' AND table_name = 'ai_decisions' AND column_name = 'win_probability') THEN
      ALTER TABLE trading_ai.ai_decisions ADD COLUMN win_probability SMALLINT;
    END IF;
  END IF;
  
  -- Check and fix in public schema (legacy)
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ai_decisions') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ai_decisions' AND column_name = 'trend_strength') THEN
      ALTER TABLE public.ai_decisions ADD COLUMN trend_strength SMALLINT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ai_decisions' AND column_name = 'setup_quality') THEN
      ALTER TABLE public.ai_decisions ADD COLUMN setup_quality SMALLINT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ai_decisions' AND column_name = 'risk') THEN
      ALTER TABLE public.ai_decisions ADD COLUMN risk SMALLINT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ai_decisions' AND column_name = 'loss_probability') THEN
      ALTER TABLE public.ai_decisions ADD COLUMN loss_probability SMALLINT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ai_decisions' AND column_name = 'win_probability') THEN
      ALTER TABLE public.ai_decisions ADD COLUMN win_probability SMALLINT;
    END IF;
  END IF;
END $$;

-- Create ai_indicator_weights table in trading_ai schema
CREATE TABLE IF NOT EXISTS trading_ai.ai_indicator_weights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coin_id VARCHAR(20),
  timeframe VARCHAR(5),
  indicator_name VARCHAR(30) NOT NULL,
  weight SMALLINT,
  performance_score SMALLINT,
  last_updated TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE (coin_id, timeframe, indicator_name)
);

-- Create ai_coin_learning table in trading_ai schema
CREATE TABLE IF NOT EXISTS trading_ai.ai_coin_learning (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coin_id VARCHAR(20) UNIQUE NOT NULL,
  total_examples INTEGER DEFAULT 0,
  total_decisions INTEGER DEFAULT 0,
  correct_decisions INTEGER DEFAULT 0,
  win_rate SMALLINT,
  avg_confidence SMALLINT,
  patterns_learned JSONB,
  last_updated TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create ai_timeframe_learning table in trading_ai schema
CREATE TABLE IF NOT EXISTS trading_ai.ai_timeframe_learning (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  timeframe VARCHAR(5) UNIQUE NOT NULL,
  total_examples INTEGER DEFAULT 0,
  total_decisions INTEGER DEFAULT 0,
  correct_decisions INTEGER DEFAULT 0,
  win_rate SMALLINT,
  avg_confidence SMALLINT,
  patterns_learned JSONB,
  last_updated TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create ai_global_learning table in trading_ai schema with INTEGER types to prevent overflow
CREATE TABLE IF NOT EXISTS trading_ai.ai_global_learning (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  total_examples INTEGER DEFAULT 0,
  total_decisions INTEGER DEFAULT 0,
  correct_decisions INTEGER DEFAULT 0,
  win_rate SMALLINT,
  avg_confidence SMALLINT,
  patterns_learned JSONB,
  last_updated TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create ai_market_patterns table in trading_ai schema
CREATE TABLE IF NOT EXISTS trading_ai.ai_market_patterns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern_name VARCHAR(50) NOT NULL,
  coin_id VARCHAR(20),
  timeframe VARCHAR(5),
  pattern_type VARCHAR(20) NOT NULL,
  success_rate SMALLINT,
  occurrence_count INTEGER DEFAULT 0,
  pattern_data JSONB,
  last_seen TIMESTAMP WITH TIME ZONE
);

-- Create ai_simulated_operations table in trading_ai schema
CREATE TABLE IF NOT EXISTS trading_ai.ai_simulated_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coin_id VARCHAR(20) NOT NULL,
  timeframe VARCHAR(5) NOT NULL,
  entry_price INTEGER,
  exit_price INTEGER,
  stop_loss INTEGER,
  take_profit INTEGER,
  result VARCHAR(10),
  profit_loss SMALLINT,
  duration_seconds INTEGER,
  confidence_at_entry SMALLINT,
  decision_data JSONB,
  timestamp TIMESTAMP WITH TIME ZONE NOT NULL
);

-- Create ai_operation_management table in trading_ai schema
CREATE TABLE IF NOT EXISTS trading_ai.ai_operation_management (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id UUID,
  coin_id VARCHAR(20) NOT NULL,
  timeframe VARCHAR(5) NOT NULL,
  current_price INTEGER,
  entry_price INTEGER,
  stop_loss INTEGER,
  take_profit INTEGER,
  trailing_stop INTEGER,
  partial_exit_percent SMALLINT,
  partial_exit_executed BOOLEAN DEFAULT false,
  decision VARCHAR(15),
  confidence SMALLINT,
  reason VARCHAR(200),
  timestamp TIMESTAMP WITH TIME ZONE NOT NULL
);

-- Create ai_daily_statistics table in trading_ai schema
CREATE TABLE IF NOT EXISTS trading_ai.ai_daily_statistics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date DATE UNIQUE NOT NULL,
  total_decisions INTEGER DEFAULT 0,
  correct_decisions INTEGER DEFAULT 0,
  win_rate SMALLINT,
  avg_confidence SMALLINT,
  operations_analyzed INTEGER DEFAULT 0,
  patterns_found INTEGER DEFAULT 0,
  learning_updates INTEGER DEFAULT 0,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create ai_learning_logs table in trading_ai schema
CREATE TABLE IF NOT EXISTS trading_ai.ai_learning_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  log_type VARCHAR(20) NOT NULL,
  coin_id VARCHAR(20),
  timeframe VARCHAR(5),
  message VARCHAR(300),
  data JSONB,
  timestamp TIMESTAMP WITH TIME ZONE NOT NULL
);

-- Create ai_configuration table in trading_ai schema
CREATE TABLE IF NOT EXISTS trading_ai.ai_configuration (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mode VARCHAR(15) NOT NULL DEFAULT 'observation',
  min_examples_for_operation INTEGER DEFAULT 1000,
  learning_rate SMALLINT,
  confidence_threshold SMALLINT,
  max_operations_per_day SMALLINT,
  current_examples_count INTEGER DEFAULT 0,
  is_operational BOOLEAN DEFAULT false,
  last_updated TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_ai_decisions_coin_time ON trading_ai.ai_decisions(coin_id, timeframe);
CREATE INDEX IF NOT EXISTS idx_ai_decisions_timestamp ON trading_ai.ai_decisions(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_ai_indicator_weights_coin ON trading_ai.ai_indicator_weights(coin_id);
CREATE INDEX IF NOT EXISTS idx_simulated_operations_coin ON trading_ai.ai_simulated_operations(coin_id);
CREATE INDEX IF NOT EXISTS idx_simulated_operations_result ON trading_ai.ai_simulated_operations(result);
CREATE INDEX IF NOT EXISTS idx_ai_learning_logs_timestamp ON trading_ai.ai_learning_logs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_ai_coin_learning_coin ON trading_ai.ai_coin_learning(coin_id);

-- Insert initial configuration
INSERT INTO trading_ai.ai_configuration (mode, min_examples_for_operation, learning_rate, confidence_threshold, max_operations_per_day)
VALUES ('observation', 1000, 1, 70, 10)
ON CONFLICT DO NOTHING;

-- Insert initial indicator weights
INSERT INTO trading_ai.ai_indicator_weights (coin_id, timeframe, indicator_name, weight, performance_score)
VALUES 
  (NULL, NULL, 'ema', 15, 50),
  (NULL, NULL, 'rsi', 15, 50),
  (NULL, NULL, 'macd', 15, 50),
  (NULL, NULL, 'adx', 10, 50),
  (NULL, NULL, 'atr', 10, 50),
  (NULL, NULL, 'bollinger', 10, 50),
  (NULL, NULL, 'stochastic', 10, 50),
  (NULL, NULL, 'supertrend', 15, 50)
ON CONFLICT DO NOTHING;

-- Insert initial timeframe learning
INSERT INTO trading_ai.ai_timeframe_learning (timeframe, total_examples, total_decisions, correct_decisions, win_rate, avg_confidence)
VALUES 
  ('1m', 0, 0, 0, 0, 0),
  ('5m', 0, 0, 0, 0, 0),
  ('15m', 0, 0, 0, 0, 0),
  ('1h', 0, 0, 0, 0, 0),
  ('4h', 0, 0, 0, 0, 0),
  ('1D', 0, 0, 0, 0, 0)
ON CONFLICT DO NOTHING;

-- Insert initial global learning
INSERT INTO trading_ai.ai_global_learning (total_examples, total_decisions, correct_decisions, win_rate, avg_confidence)
VALUES (0, 0, 0, 0, 0)
ON CONFLICT DO NOTHING;
