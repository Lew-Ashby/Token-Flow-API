import crypto from 'crypto';
import { db } from '../utils/database';
import { hashApiKey } from '../middleware/auth.middleware';

export interface GeneratedApiKey {
  key: string; // The actual key (show only once!)
  keyHash: string; // Hash stored in database
  keyPrefix: string; // First 12 chars for display
  userId: string;
  id: string;
}

export interface ApiKeyInfo {
  id: string;
  keyPrefix: string;
  name: string | null;
  active: boolean;
  totalCalls: number;
  lastUsedAt: Date | null;
  createdAt: Date;
  expiresAt: Date | null;
}

/**
 * Generate a new API key
 * Format: tfa_live_<64_random_hex_chars>
 */
export function generateApiKey(): string {
  const prefix = 'tfa_live_';
  const randomBytes = crypto.randomBytes(32); // 32 bytes = 64 hex chars
  const randomHex = randomBytes.toString('hex');
  return prefix + randomHex;
}

/**
 * Create a new API key for a user
 */
export async function createApiKey(
  userId: string,
  name?: string
): Promise<GeneratedApiKey> {
  // Generate the key
  const apiKey = generateApiKey();
  const keyHash = hashApiKey(apiKey);
  const keyPrefix = apiKey.substring(0, 16); // Show first 16 chars

  // Store in database
  const result = await db.query(
    `INSERT INTO api_keys (key_hash, key_prefix, user_id, name, active, total_calls, created_at)
     VALUES ($1, $2, $3, $4, true, 0, NOW())
     RETURNING id`,
    [keyHash, keyPrefix, userId, name || null]
  );

  const keyId = result.rows[0].id;

  return {
    key: apiKey, // IMPORTANT: This is the only time we return the full key!
    keyHash,
    keyPrefix,
    userId,
    id: keyId,
  };
}

/**
 * Get all API keys for a user (without the actual key values)
 */
export async function getUserApiKeys(userId: string): Promise<ApiKeyInfo[]> {
  const result = await db.query(
    `SELECT id, key_prefix, name, active, total_calls, last_used_at, created_at, expires_at
     FROM api_keys
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [userId]
  );

  return result.rows.map(row => ({
    id: row.id,
    keyPrefix: row.key_prefix,
    name: row.name,
    active: row.active,
    totalCalls: parseInt(row.total_calls) || 0,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  }));
}

/**
 * Revoke (deactivate) an API key
 */
export async function revokeApiKey(keyId: string, userId: string): Promise<boolean> {
  const result = await db.query(
    `UPDATE api_keys
     SET active = false, revoked_at = NOW()
     WHERE id = $1 AND user_id = $2
     RETURNING id`,
    [keyId, userId]
  );

  return result.rowCount > 0;
}

/**
 * Get API key details by hash
 */
export async function getApiKeyByHash(keyHash: string): Promise<any> {
  const result = await db.query(
    `SELECT k.*, u.subscription_plan, u.subscription_status, s.current_usage, s.monthly_quota, s.rate_limit_per_minute
     FROM api_keys k
     JOIN users u ON k.user_id = u.id
     LEFT JOIN subscriptions s ON u.id = s.user_id AND s.status = 'active'
     WHERE k.key_hash = $1 AND k.active = true`,
    [keyHash]
  );

  return result.rows[0] || null;
}

/**
 * Validate API key and return user context
 */
export async function validateApiKey(apiKey: string): Promise<{
  valid: boolean;
  user?: any;
  subscription?: any;
  reason?: string;
}> {
  const keyHash = hashApiKey(apiKey);
  const keyData = await getApiKeyByHash(keyHash);

  if (!keyData) {
    return { valid: false, reason: 'Invalid or revoked API key' };
  }

  // Check if subscription is active
  if (keyData.subscription_status !== 'active') {
    return { valid: false, reason: 'Subscription inactive' };
  }

  // Check if over quota
  if (keyData.current_usage >= keyData.monthly_quota) {
    return {
      valid: false,
      reason: 'Quota exceeded',
      user: {
        id: keyData.user_id,
        email: keyData.email,
        plan: keyData.subscription_plan,
      },
      subscription: {
        currentUsage: keyData.current_usage,
        monthlyQuota: keyData.monthly_quota,
      },
    };
  }

  return {
    valid: true,
    user: {
      id: keyData.user_id,
      plan: keyData.subscription_plan,
      status: keyData.subscription_status,
    },
    subscription: {
      currentUsage: keyData.current_usage,
      monthlyQuota: keyData.monthly_quota,
      rateLimitPerMinute: keyData.rate_limit_per_minute,
    },
  };
}

/**
 * Increment API key usage counter
 */
export async function incrementKeyUsage(keyHash: string): Promise<void> {
  await db.query(
    `UPDATE api_keys
     SET total_calls = total_calls + 1, last_used_at = NOW()
     WHERE key_hash = $1`,
    [keyHash]
  );
}
