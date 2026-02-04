import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { db } from '../utils/database';
import { ApiKeyData } from '../types';

// Extended type definitions for user context
export interface UserContext {
  id: string;
  email: string;
  plan: string;
  status: string;
}

export interface SubscriptionContext {
  currentUsage: number;
  monthlyQuota: number;
  rateLimitPerMinute: number;
  billingPeriodEnd: Date;
}

declare global {
  namespace Express {
    interface Request {
      apiKeyData?: ApiKeyData;
      user?: UserContext;
      subscription?: SubscriptionContext;
    }
  }
}

export function hashApiKey(apiKey: string): string {
  const salt = process.env.API_KEY_SALT!;

  if (!salt || salt === 'default_salt_change_in_production') {
    throw new Error('FATAL: API_KEY_SALT must be set to a secure value');
  }

  return crypto
    .createHmac('sha256', salt)
    .update(apiKey)
    .digest('hex');
}

// Constant-time delay to prevent timing attacks
async function constantTimeDelay(ms: number = 50): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function authenticateApiKey(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const startTime = Date.now();
  const apiKey = req.headers['x-api-key'] as string;

  if (!apiKey) {
    // Add delay to prevent timing analysis
    await constantTimeDelay();
    res.status(401).json({ error: 'API key required' });
    return;
  }

  const keyHash = hashApiKey(apiKey);

  // Enhanced query: Join with users and subscriptions to get full context
  const result = await db.query(
    `SELECT
      k.*,
      u.id as user_id,
      u.email as user_email,
      u.subscription_plan as user_plan,
      u.subscription_status as user_status,
      s.current_usage,
      s.monthly_quota,
      s.rate_limit_per_minute,
      s.billing_period_end
     FROM api_keys k
     JOIN users u ON k.user_id = u.id
     LEFT JOIN subscriptions s ON u.id = s.user_id AND s.status = 'active'
     WHERE k.key_hash = $1 AND k.active = true`,
    [keyHash]
  );

  const isValid = result.rows.length > 0;

  if (!isValid) {
    // Ensure consistent timing for invalid keys
    const elapsed = Date.now() - startTime;
    const remaining = Math.max(0, 50 - elapsed);
    await constantTimeDelay(remaining);

    res.status(401).json({ error: 'Invalid API key' });
    return;
  }

  const keyData = result.rows[0];

  // Set API key data (backward compatible)
  req.apiKeyData = keyData;

  // Add user context to request
  req.user = {
    id: keyData.user_id,
    email: keyData.user_email,
    plan: keyData.user_plan,
    status: keyData.user_status,
  };

  // Add subscription context if available
  if (keyData.current_usage !== null) {
    req.subscription = {
      currentUsage: parseInt(keyData.current_usage) || 0,
      monthlyQuota: parseInt(keyData.monthly_quota) || 0,
      rateLimitPerMinute: parseInt(keyData.rate_limit_per_minute) || 0,
      billingPeriodEnd: keyData.billing_period_end,
    };
  }

  // Update last_used_at asynchronously (don't block request)
  db.query(
    'UPDATE api_keys SET last_used_at = NOW() WHERE key_hash = $1',
    [keyHash]
  ).catch(err => console.error('Failed to update last_used_at:', err));

  next();
}
