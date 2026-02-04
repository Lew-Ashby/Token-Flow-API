-- Migration: Add User Management and API Key Generation System
-- Date: 2026-02-04
-- Purpose: Support APIX integration with self-managed user accounts

-- ============================================================================
-- USERS TABLE
-- ============================================================================
-- Stores user account information
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    full_name VARCHAR(255),
    company_name VARCHAR(255),

    -- Subscription info
    subscription_plan VARCHAR(50) NOT NULL DEFAULT 'starter', -- 'starter', 'pro', 'enterprise'
    subscription_status VARCHAR(20) NOT NULL DEFAULT 'active', -- 'active', 'cancelled', 'expired'

    -- External references
    apix_user_id VARCHAR(255) UNIQUE, -- APIX's user ID
    stripe_customer_id VARCHAR(255) UNIQUE, -- If using Stripe

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_login_at TIMESTAMP WITH TIME ZONE
);

-- Index for faster lookups
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_apix_id ON users(apix_user_id);
CREATE INDEX idx_users_subscription_status ON users(subscription_status);

-- ============================================================================
-- SUBSCRIPTIONS TABLE
-- ============================================================================
-- Tracks subscription details and quotas
CREATE TABLE IF NOT EXISTS subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- Plan details
    plan VARCHAR(50) NOT NULL, -- 'starter', 'pro', 'enterprise'

    -- Quota limits (per billing period)
    monthly_quota INTEGER NOT NULL, -- Max API calls per month
    rate_limit_per_minute INTEGER NOT NULL, -- Max calls per minute

    -- Current usage
    current_usage INTEGER DEFAULT 0,

    -- Billing period
    billing_period_start DATE NOT NULL,
    billing_period_end DATE NOT NULL,

    -- Status
    status VARCHAR(20) NOT NULL DEFAULT 'active', -- 'active', 'cancelled', 'expired', 'past_due'

    -- Pricing
    price_cents INTEGER NOT NULL, -- Price in cents (e.g., 5000 = $50.00)
    currency VARCHAR(3) DEFAULT 'USD',

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    cancelled_at TIMESTAMP WITH TIME ZONE,
    expires_at TIMESTAMP WITH TIME ZONE
);

-- Indexes
CREATE INDEX idx_subscriptions_user_id ON subscriptions(user_id);
CREATE INDEX idx_subscriptions_status ON subscriptions(status);
CREATE INDEX idx_subscriptions_billing_period ON subscriptions(billing_period_start, billing_period_end);

-- Ensure only one active subscription per user
CREATE UNIQUE INDEX idx_subscriptions_user_active ON subscriptions(user_id)
    WHERE status = 'active';

-- ============================================================================
-- API_KEYS TABLE (Enhanced)
-- ============================================================================
-- Note: May already exist from init.sql, so using IF NOT EXISTS
CREATE TABLE IF NOT EXISTS api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key_hash VARCHAR(128) UNIQUE NOT NULL,
    key_prefix VARCHAR(20) NOT NULL, -- First 8 chars for display (e.g., "tfa_live")

    -- User reference
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,

    -- Key details
    name VARCHAR(100), -- Optional name for the key (e.g., "Production", "Development")
    active BOOLEAN DEFAULT true,

    -- Usage tracking
    total_calls INTEGER DEFAULT 0,
    last_used_at TIMESTAMP WITH TIME ZONE,

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE,
    revoked_at TIMESTAMP WITH TIME ZONE
);

-- Indexes
CREATE INDEX idx_api_keys_user_id ON api_keys(user_id);
CREATE INDEX idx_api_keys_active ON api_keys(active) WHERE active = true;
CREATE INDEX idx_api_keys_hash ON api_keys(key_hash);

-- ============================================================================
-- API_USAGE_LOGS TABLE
-- ============================================================================
-- Detailed logging of API calls for analytics and billing
CREATE TABLE IF NOT EXISTS api_usage_logs (
    id BIGSERIAL PRIMARY KEY,

    -- User info
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    api_key_id UUID REFERENCES api_keys(id) ON DELETE SET NULL,

    -- Request details
    endpoint VARCHAR(255) NOT NULL,
    method VARCHAR(10) NOT NULL, -- GET, POST, etc.

    -- Response details
    status_code INTEGER NOT NULL,
    response_time_ms INTEGER, -- Response time in milliseconds

    -- Request metadata
    user_agent TEXT,
    ip_address INET,
    request_id VARCHAR(100),

    -- Timestamp (partitioned for performance)
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX idx_api_usage_user_id ON api_usage_logs(user_id);
CREATE INDEX idx_api_usage_timestamp ON api_usage_logs(timestamp DESC);
CREATE INDEX idx_api_usage_user_timestamp ON api_usage_logs(user_id, timestamp DESC);
CREATE INDEX idx_api_usage_endpoint ON api_usage_logs(endpoint);

-- Partition by month for better performance (optional but recommended for high traffic)
-- This would be implemented as needed based on traffic volume

-- ============================================================================
-- WEBHOOK_EVENTS TABLE
-- ============================================================================
-- Store incoming webhooks from APIX for debugging and replay
CREATE TABLE IF NOT EXISTS webhook_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Webhook source
    source VARCHAR(50) NOT NULL, -- 'apix', 'stripe', etc.
    event_type VARCHAR(100) NOT NULL, -- 'user.subscribed', 'payment.succeeded', etc.

    -- Payload
    payload JSONB NOT NULL,

    -- Processing
    processed BOOLEAN DEFAULT false,
    processed_at TIMESTAMP WITH TIME ZONE,
    error_message TEXT,
    retry_count INTEGER DEFAULT 0,

    -- Timestamps
    received_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_webhook_events_source ON webhook_events(source);
CREATE INDEX idx_webhook_events_type ON webhook_events(event_type);
CREATE INDEX idx_webhook_events_processed ON webhook_events(processed) WHERE processed = false;
CREATE INDEX idx_webhook_events_received ON webhook_events(received_at DESC);

-- ============================================================================
-- PLAN_LIMITS TABLE
-- ============================================================================
-- Define limits for each subscription plan
CREATE TABLE IF NOT EXISTS plan_limits (
    plan VARCHAR(50) PRIMARY KEY,
    monthly_quota INTEGER NOT NULL,
    rate_limit_per_minute INTEGER NOT NULL,
    rate_limit_per_hour INTEGER NOT NULL,
    price_cents INTEGER NOT NULL,
    features JSONB DEFAULT '{}', -- Additional features as JSON
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Insert default plans
INSERT INTO plan_limits (plan, monthly_quota, rate_limit_per_minute, rate_limit_per_hour, price_cents, features)
VALUES
    ('starter', 1000, 10, 100, 1000, '{"support": "email", "priority": false, "webhooks": false}'),
    ('pro', 10000, 60, 1000, 5000, '{"support": "email", "priority": true, "webhooks": true}'),
    ('enterprise', 100000, 600, 10000, 20000, '{"support": "24/7", "priority": true, "webhooks": true, "custom_integration": true}')
ON CONFLICT (plan) DO NOTHING;

-- ============================================================================
-- VIEWS FOR ANALYTICS
-- ============================================================================

-- Active users with current usage
CREATE OR REPLACE VIEW active_users_with_usage AS
SELECT
    u.id,
    u.email,
    u.subscription_plan,
    s.current_usage,
    s.monthly_quota,
    ROUND((s.current_usage::DECIMAL / s.monthly_quota::DECIMAL) * 100, 2) AS usage_percentage,
    s.billing_period_start,
    s.billing_period_end,
    u.created_at,
    u.last_login_at
FROM users u
JOIN subscriptions s ON u.id = s.user_id
WHERE s.status = 'active'
ORDER BY s.current_usage DESC;

-- Usage statistics per user
CREATE OR REPLACE VIEW user_usage_stats AS
SELECT
    u.id AS user_id,
    u.email,
    COUNT(DISTINCT l.id) AS total_calls,
    COUNT(DISTINCT DATE(l.timestamp)) AS active_days,
    AVG(l.response_time_ms)::INTEGER AS avg_response_time_ms,
    COUNT(CASE WHEN l.status_code >= 400 THEN 1 END) AS error_count,
    MAX(l.timestamp) AS last_api_call
FROM users u
LEFT JOIN api_usage_logs l ON u.id = l.user_id
WHERE l.timestamp >= NOW() - INTERVAL '30 days'
GROUP BY u.id, u.email;

-- ============================================================================
-- FUNCTIONS
-- ============================================================================

-- Function to reset monthly usage
CREATE OR REPLACE FUNCTION reset_monthly_usage()
RETURNS void AS $$
BEGIN
    UPDATE subscriptions
    SET
        current_usage = 0,
        billing_period_start = billing_period_end,
        billing_period_end = billing_period_end + INTERVAL '1 month',
        updated_at = NOW()
    WHERE billing_period_end <= CURRENT_DATE
      AND status = 'active';
END;
$$ LANGUAGE plpgsql;

-- Function to increment usage
CREATE OR REPLACE FUNCTION increment_user_usage(p_user_id UUID)
RETURNS void AS $$
BEGIN
    UPDATE subscriptions
    SET
        current_usage = current_usage + 1,
        updated_at = NOW()
    WHERE user_id = p_user_id
      AND status = 'active';
END;
$$ LANGUAGE plpgsql;

-- Function to check if user is over quota
CREATE OR REPLACE FUNCTION is_over_quota(p_user_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
    v_current_usage INTEGER;
    v_monthly_quota INTEGER;
BEGIN
    SELECT current_usage, monthly_quota
    INTO v_current_usage, v_monthly_quota
    FROM subscriptions
    WHERE user_id = p_user_id
      AND status = 'active';

    IF NOT FOUND THEN
        RETURN TRUE; -- No active subscription = over quota
    END IF;

    RETURN v_current_usage >= v_monthly_quota;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- TRIGGERS
-- ============================================================================

-- Auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_subscriptions_updated_at
    BEFORE UPDATE ON subscriptions
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- GRANTS (Adjust based on your user permissions)
-- ============================================================================

-- Grant permissions to your API user
GRANT SELECT, INSERT, UPDATE ON users TO token_flow_user;
GRANT SELECT, INSERT, UPDATE ON subscriptions TO token_flow_user;
GRANT SELECT, INSERT, UPDATE ON api_keys TO token_flow_user;
GRANT SELECT, INSERT ON api_usage_logs TO token_flow_user;
GRANT SELECT, INSERT, UPDATE ON webhook_events TO token_flow_user;
GRANT SELECT ON plan_limits TO token_flow_user;
GRANT SELECT ON active_users_with_usage TO token_flow_user;
GRANT SELECT ON user_usage_stats TO token_flow_user;

-- Grant sequence permissions
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO token_flow_user;

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON TABLE users IS 'User accounts for API access';
COMMENT ON TABLE subscriptions IS 'Active subscriptions with quota tracking';
COMMENT ON TABLE api_keys IS 'API keys for authentication';
COMMENT ON TABLE api_usage_logs IS 'Detailed API call logs for billing and analytics';
COMMENT ON TABLE webhook_events IS 'Incoming webhook events from external services';
COMMENT ON TABLE plan_limits IS 'Configuration for subscription plans';

-- ============================================================================
-- VERIFICATION QUERIES
-- ============================================================================

-- Verify tables were created
DO $$
BEGIN
    RAISE NOTICE 'Migration completed successfully!';
    RAISE NOTICE 'Tables created: users, subscriptions, api_keys, api_usage_logs, webhook_events, plan_limits';
    RAISE NOTICE 'Views created: active_users_with_usage, user_usage_stats';
    RAISE NOTICE 'Functions created: reset_monthly_usage, increment_user_usage, is_over_quota';
END $$;
