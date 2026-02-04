-- Token Flow Path Analysis API Database Schema

CREATE TABLE IF NOT EXISTS transactions (
  signature VARCHAR(88) PRIMARY KEY,
  block_time BIGINT NOT NULL,
  slot BIGINT NOT NULL,
  fee BIGINT NOT NULL,
  success BOOLEAN NOT NULL,
  accounts JSONB NOT NULL,
  instructions JSONB NOT NULL,
  indexed_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transactions_block_time ON transactions(block_time);
CREATE INDEX IF NOT EXISTS idx_transactions_accounts ON transactions USING GIN(accounts);

CREATE TABLE IF NOT EXISTS transfers (
  id SERIAL PRIMARY KEY,
  signature VARCHAR(88) REFERENCES transactions(signature) ON DELETE CASCADE,
  from_address VARCHAR(44) NOT NULL,
  to_address VARCHAR(44) NOT NULL,
  token_mint VARCHAR(44) NOT NULL,
  amount BIGINT NOT NULL,
  decimals INT NOT NULL,
  instruction_index INT NOT NULL,
  indexed_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transfers_from ON transfers(from_address);
CREATE INDEX IF NOT EXISTS idx_transfers_to ON transfers(to_address);
CREATE INDEX IF NOT EXISTS idx_transfers_token ON transfers(token_mint);
CREATE INDEX IF NOT EXISTS idx_transfers_signature ON transfers(signature);

CREATE TABLE IF NOT EXISTS flow_paths (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  start_address VARCHAR(44) NOT NULL,
  end_address VARCHAR(44) NOT NULL,
  token_mint VARCHAR(44) NOT NULL,
  path_hops JSONB NOT NULL,
  total_amount BIGINT NOT NULL,
  hop_count INT NOT NULL,
  confidence_score DECIMAL(5,4),
  intent_label VARCHAR(50),
  analyzed_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_flow_paths_start ON flow_paths(start_address);
CREATE INDEX IF NOT EXISTS idx_flow_paths_end ON flow_paths(end_address);
CREATE INDEX IF NOT EXISTS idx_flow_paths_token ON flow_paths(token_mint);

CREATE TABLE IF NOT EXISTS entities (
  address VARCHAR(44) PRIMARY KEY,
  entity_type VARCHAR(50),
  name VARCHAR(255),
  risk_level VARCHAR(20) DEFAULT 'low',
  risk_score DECIMAL(5,2) DEFAULT 0,
  metadata JSONB,
  last_updated TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(entity_type);
CREATE INDEX IF NOT EXISTS idx_entities_risk ON entities(risk_level);

CREATE TABLE IF NOT EXISTS risk_flags (
  id SERIAL PRIMARY KEY,
  address VARCHAR(44) NOT NULL,
  flag_type VARCHAR(50) NOT NULL,
  severity VARCHAR(20) NOT NULL,
  details JSONB,
  detected_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_risk_flags_address ON risk_flags(address);
CREATE INDEX IF NOT EXISTS idx_risk_flags_type ON risk_flags(flag_type);
CREATE INDEX IF NOT EXISTS idx_risk_flags_severity ON risk_flags(severity);

CREATE TABLE IF NOT EXISTS api_keys (
  key_hash VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  tier VARCHAR(20) DEFAULT 'free',
  rate_limit_per_minute INT DEFAULT 10,
  created_at TIMESTAMP DEFAULT NOW(),
  last_used_at TIMESTAMP,
  active BOOLEAN DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_active ON api_keys(active);

-- Seed some known entities (DEXes, Bridges, etc.)
INSERT INTO entities (address, entity_type, name, risk_level, risk_score) VALUES
  ('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', 'dex', 'Raydium', 'low', 0),
  ('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', 'dex', 'Orca', 'low', 0),
  ('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', 'dex', 'Jupiter', 'low', 0),
  ('JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB', 'dex', 'Jupiter', 'low', 0),
  ('worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth', 'bridge', 'Wormhole', 'low', 0),
  ('DZnkkTmCiFWfYTfT41X3Rd1kDgozqzxWaHqsw6W4x2oe', 'bridge', 'Portal', 'low', 0),
  ('So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo', 'lending', 'Solend', 'low', 0),
  ('MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA', 'lending', 'MarginFi', 'low', 0)
ON CONFLICT (address) DO NOTHING;

-- Insert a test API key (key: test_api_key_12345, hash using default salt)
-- In production, use proper API key generation
INSERT INTO api_keys (key_hash, user_id, tier, rate_limit_per_minute, active) VALUES
  ('6d5e1e7c9a8f4b2d3c1a9f7e6d5c4b3a2f1e9d8c7b6a5f4e3d2c1b0a9f8e7d6', 'test_user', 'free', 10, true)
ON CONFLICT (key_hash) DO NOTHING;

-- Create function to clean old data
CREATE OR REPLACE FUNCTION clean_old_data() RETURNS void AS $$
BEGIN
  DELETE FROM transactions WHERE indexed_at < NOW() - INTERVAL '90 days';
  DELETE FROM flow_paths WHERE analyzed_at < NOW() - INTERVAL '30 days';
  DELETE FROM risk_flags WHERE detected_at < NOW() - INTERVAL '60 days';
END;
$$ LANGUAGE plpgsql;
