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
  if (!req.apiKeyData) {
    res.status(401).json({ error: 'API key required' });
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
