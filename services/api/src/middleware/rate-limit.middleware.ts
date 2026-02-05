import { Request, Response, NextFunction } from 'express';
import { RateLimiterRedis } from 'rate-limiter-flexible';
import { redis } from '../utils/redis';

// LRU cache to prevent memory leak from unbounded Map growth
class LRUCache<K, V> {
  private cache: Map<K, { value: V; lastUsed: number }>;
  private maxSize: number;
  private ttl: number;

  constructor(maxSize: number = 1000, ttlMs: number = 3600000) {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.ttl = ttlMs;
  }

  get(key: K): V | undefined {
    const item = this.cache.get(key);
    if (!item) return undefined;

    // Check TTL
    if (Date.now() - item.lastUsed > this.ttl) {
      this.cache.delete(key);
      return undefined;
    }

    // Update last used
    item.lastUsed = Date.now();
    return item.value;
  }

  set(key: K, value: V): void {
    // Evict oldest entries if cache is full
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.findOldest();
      if (oldestKey) this.cache.delete(oldestKey);
    }

    this.cache.set(key, { value, lastUsed: Date.now() });
  }

  private findOldest(): K | undefined {
    let oldestKey: K | undefined;
    let oldestTime = Infinity;

    for (const [key, item] of this.cache.entries()) {
      if (item.lastUsed < oldestTime) {
        oldestTime = item.lastUsed;
        oldestKey = key;
      }
    }

    return oldestKey;
  }

  size(): number {
    return this.cache.size;
  }
}

const limiters = new LRUCache<string, RateLimiterRedis>(1000, 3600000);

function getLimiter(keyHash: string, points: number): RateLimiterRedis {
  let limiter = limiters.get(keyHash);

  if (!limiter) {
    limiter = new RateLimiterRedis({
      storeClient: redis.getClient(),
      keyPrefix: `rate_limit:${keyHash}`,
      points,
      duration: 60,
      blockDuration: 60,
    });
    limiters.set(keyHash, limiter);
  }

  return limiter;
}

export async function rateLimiter(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  // For APIX public routes (no API key), use IP-based rate limiting
  if (!req.apiKeyData) {
    // Allow public APIX routes with IP-based limiting
    const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
    const publicLimit = 30; // 30 requests per minute for public routes

    // Simple in-memory rate limiting for public routes
    const now = Date.now();
    const windowMs = 60000; // 1 minute
    const key = `public:${ip}`;

    if (!publicRateLimits.has(key)) {
      publicRateLimits.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }

    const limit = publicRateLimits.get(key)!;

    if (now > limit.resetAt) {
      limit.count = 1;
      limit.resetAt = now + windowMs;
      next();
      return;
    }

    if (limit.count >= publicLimit) {
      const retryAfter = Math.ceil((limit.resetAt - now) / 1000);
      res.status(429).json({
        error: 'Rate limit exceeded',
        retryAfter,
        limit: publicLimit,
      });
      return;
    }

    limit.count++;
    next();
    return;
  }

  const { key_hash, rate_limit_per_minute } = req.apiKeyData;
  const limiter = getLimiter(key_hash, rate_limit_per_minute);

  try {
    const rlRes = await limiter.consume(key_hash);

    // Always send rate limit headers (even on success)
    res.setHeader('X-RateLimit-Limit', rate_limit_per_minute.toString());
    res.setHeader('X-RateLimit-Remaining', rlRes.remainingPoints.toString());
    res.setHeader('X-RateLimit-Reset', new Date(Date.now() + rlRes.msBeforeNext).toISOString());

    next();
  } catch (error: any) {
    const retryAfter = Math.ceil(error.msBeforeNext / 1000);

    res.setHeader('Retry-After', retryAfter.toString());
    res.setHeader('X-RateLimit-Limit', rate_limit_per_minute.toString());
    res.setHeader('X-RateLimit-Remaining', '0');
    res.setHeader('X-RateLimit-Reset', new Date(Date.now() + error.msBeforeNext).toISOString());

    res.status(429).json({
      error: 'Rate limit exceeded',
      retryAfter,
      limit: rate_limit_per_minute,
    });
  }
}

// Simple in-memory store for public rate limiting
const publicRateLimits = new Map<string, { count: number; resetAt: number }>();

// Clean up old entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of publicRateLimits.entries()) {
    if (now > value.resetAt) {
      publicRateLimits.delete(key);
    }
  }
}, 300000);
