import { Request, Response, NextFunction } from 'express';
import { db } from '../utils/database';
import { incrementUserUsage, isUserOverQuota } from '../services/user.service';
import { incrementKeyUsage } from '../services/api-key.service';
import { hashApiKey } from './auth.middleware';

/**
 * Usage Tracking & Quota Enforcement Middleware
 *
 * This middleware:
 * 1. Tracks each API call in usage logs
 * 2. Increments user's usage counter
 * 3. Enforces quota limits
 * 4. Enforces rate limits
 */
export async function trackUsageAndEnforceQuota(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const startTime = Date.now();

  try {
    const userId = req.apiKeyData?.user_id;
    const apiKey = req.headers['x-api-key'] as string;

    if (!userId || !apiKey) {
      // No user context, skip tracking (health check, etc.)
      next();
      return;
    }

    // 1. Check if user is over quota
    const overQuota = await isUserOverQuota(userId);

    if (overQuota) {
      // Get subscription details for error message
      const subResult = await db.query(
        `SELECT current_usage, monthly_quota, billing_period_end
         FROM subscriptions
         WHERE user_id = $1 AND status = 'active'`,
        [userId]
      );

      const subscription = subResult.rows[0];

      res.status(429).json({
        error: 'Quota exceeded',
        message: `You have exceeded your monthly quota of ${subscription?.monthly_quota || 0} API calls`,
        usage: {
          current: subscription?.current_usage || 0,
          limit: subscription?.monthly_quota || 0,
          resetDate: subscription?.billing_period_end,
        },
        upgradeUrl: 'https://apix-frontend.web.app/upgrade', // Adjust to your upgrade URL
      });
      return;
    }

    // 2. Check rate limit (calls per minute)
    const rateLimitOk = await checkRateLimit(userId);

    if (!rateLimitOk) {
      res.status(429).json({
        error: 'Rate limit exceeded',
        message: 'Too many requests. Please slow down.',
        retryAfter: 60, // seconds
      });
      return;
    }

    // 3. Increment usage counters (asynchronously - don't block request)
    Promise.all([
      incrementUserUsage(userId),
      incrementKeyUsage(hashApiKey(apiKey)),
    ]).catch(err => console.error('Failed to increment usage:', err));

    // 4. Continue to the actual API endpoint
    next();

    // 5. Log the API call after response is sent (non-blocking)
    res.on('finish', () => {
      const responseTime = Date.now() - startTime;
      logApiCall(req, res, userId, responseTime).catch(err =>
        console.error('Failed to log API call:', err)
      );
    });
  } catch (error) {
    console.error('Usage tracking error:', error);
    // Don't block the request if tracking fails
    next();
  }
}

/**
 * Check rate limit using Redis
 * Returns true if within limit, false if exceeded
 */
async function checkRateLimit(userId: string): Promise<boolean> {
  try {
    // Get user's rate limit from subscription
    const result = await db.query(
      `SELECT s.rate_limit_per_minute
       FROM subscriptions s
       WHERE s.user_id = $1 AND s.status = 'active'`,
      [userId]
    );

    if (result.rows.length === 0) {
      return false; // No active subscription
    }

    const rateLimit = result.rows[0].rate_limit_per_minute;

    // Check recent API calls in last minute
    const recentCallsResult = await db.query(
      `SELECT COUNT(*) as call_count
       FROM api_usage_logs
       WHERE user_id = $1
         AND timestamp > NOW() - INTERVAL '1 minute'`,
      [userId]
    );

    const recentCalls = parseInt(recentCallsResult.rows[0]?.call_count || '0');

    return recentCalls < rateLimit;
  } catch (error) {
    console.error('Rate limit check error:', error);
    return true; // Allow request if check fails
  }
}

/**
 * Log API call to database for analytics and billing
 */
async function logApiCall(
  req: Request,
  res: Response,
  userId: string,
  responseTimeMs: number
): Promise<void> {
  try {
    const apiKey = req.headers['x-api-key'] as string;
    const keyHash = hashApiKey(apiKey);

    // Get API key ID
    const keyResult = await db.query(
      'SELECT id FROM api_keys WHERE key_hash = $1',
      [keyHash]
    );

    const apiKeyId = keyResult.rows[0]?.id || null;

    // Insert usage log
    await db.query(
      `INSERT INTO api_usage_logs (
        user_id,
        api_key_id,
        endpoint,
        method,
        status_code,
        response_time_ms,
        user_agent,
        ip_address,
        request_id,
        timestamp
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
      [
        userId,
        apiKeyId,
        req.path,
        req.method,
        res.statusCode,
        responseTimeMs,
        req.headers['user-agent'] || null,
        req.ip || req.socket.remoteAddress || null,
        req.requestId || null,
      ]
    );
  } catch (error) {
    console.error('Failed to log API call:', error);
    // Don't throw - logging failure shouldn't affect the request
  }
}

/**
 * Add usage info to response headers
 */
export function addUsageHeaders(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const userId = req.apiKeyData?.user_id;

  if (userId) {
    // Get subscription info
    db.query(
      `SELECT current_usage, monthly_quota, rate_limit_per_minute, billing_period_end
       FROM subscriptions
       WHERE user_id = $1 AND status = 'active'`,
      [userId]
    )
      .then(result => {
        if (result.rows.length > 0) {
          const sub = result.rows[0];

          // Add rate limit headers (standard format)
          res.setHeader('X-RateLimit-Limit', sub.rate_limit_per_minute);
          res.setHeader('X-RateLimit-Remaining', Math.max(0, sub.rate_limit_per_minute - 1));
          res.setHeader('X-RateLimit-Reset', Math.floor(new Date(Date.now() + 60000).getTime() / 1000));

          // Add quota headers
          res.setHeader('X-Quota-Limit', sub.monthly_quota);
          res.setHeader('X-Quota-Remaining', Math.max(0, sub.monthly_quota - sub.current_usage));
          res.setHeader('X-Quota-Reset', new Date(sub.billing_period_end).toISOString());
        }
      })
      .catch(err => console.error('Failed to add usage headers:', err));
  }

  next();
}

/**
 * Middleware to exclude certain paths from usage tracking
 * (e.g., health checks, webhooks)
 */
export function shouldTrackUsage(req: Request): boolean {
  const excludedPaths = [
    '/health',
    '/webhooks',
    '/metrics',
  ];

  return !excludedPaths.some(path => req.path.startsWith(path));
}

/**
 * Combined middleware: Track usage only if needed
 */
export function usageTrackingMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (shouldTrackUsage(req)) {
    trackUsageAndEnforceQuota(req, res, next);
  } else {
    next();
  }
}
