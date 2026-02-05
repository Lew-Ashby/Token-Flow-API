import Redis from 'ioredis';

interface IRedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<void>;
  getJson<T>(key: string): Promise<T | null>;
  setJson(key: string, value: any, ttlSeconds?: number): Promise<void>;
  getClient(): Redis | null;
  close(): Promise<void>;
  isConnected(): boolean;
}

class NoOpRedisClient implements IRedisClient {
  async get(_key: string): Promise<string | null> {
    return null;
  }

  async set(_key: string, _value: string, _ttlSeconds?: number): Promise<void> {
    // No-op
  }

  async del(_key: string): Promise<void> {
    // No-op
  }

  async incr(_key: string): Promise<number> {
    return 1;
  }

  async expire(_key: string, _seconds: number): Promise<void> {
    // No-op
  }

  async getJson<T>(_key: string): Promise<T | null> {
    return null;
  }

  async setJson(_key: string, _value: any, _ttlSeconds?: number): Promise<void> {
    // No-op
  }

  getClient(): Redis | null {
    return null;
  }

  async close(): Promise<void> {
    // No-op
  }

  isConnected(): boolean {
    return false;
  }
}

class RealRedisClient implements IRedisClient {
  private client: Redis;
  private connected: boolean = false;

  constructor() {
    this.client = new Redis({
      host: process.env.REDIS_HOST,
      port: parseInt(process.env.REDIS_PORT || '6379'),
      retryStrategy: (times) => {
        if (times > 3) {
          console.warn('Redis: Max retries reached, giving up');
          return null;
        }
        const delay = Math.min(times * 50, 2000);
        return delay;
      },
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    });

    this.client.on('error', (err) => {
      console.error('Redis connection error:', err.message);
      this.connected = false;
    });

    this.client.on('connect', () => {
      console.log('Redis connected');
      this.connected = true;
    });

    this.client.on('close', () => {
      this.connected = false;
    });

    this.client.connect().catch((err) => {
      console.warn('Redis connection failed:', err.message);
      this.connected = false;
    });
  }

  async get(key: string): Promise<string | null> {
    if (!this.connected) return null;
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (!this.connected) return;
    if (ttlSeconds) {
      await this.client.setex(key, ttlSeconds, value);
    } else {
      await this.client.set(key, value);
    }
  }

  async del(key: string): Promise<void> {
    if (!this.connected) return;
    await this.client.del(key);
  }

  async incr(key: string): Promise<number> {
    if (!this.connected) return 1;
    return this.client.incr(key);
  }

  async expire(key: string, seconds: number): Promise<void> {
    if (!this.connected) return;
    await this.client.expire(key, seconds);
  }

  async getJson<T>(key: string): Promise<T | null> {
    if (!this.connected) return null;
    const data = await this.client.get(key);
    return data ? JSON.parse(data) : null;
  }

  async setJson(key: string, value: any, ttlSeconds?: number): Promise<void> {
    if (!this.connected) return;
    const data = JSON.stringify(value);
    await this.set(key, data, ttlSeconds);
  }

  getClient(): Redis | null {
    return this.connected ? this.client : null;
  }

  async close(): Promise<void> {
    if (this.connected) {
      await this.client.quit();
    }
  }

  isConnected(): boolean {
    return this.connected;
  }
}

function createRedisClient(): IRedisClient {
  const redisHost = process.env.REDIS_HOST;

  if (!redisHost || redisHost === 'localhost' || redisHost === '127.0.0.1') {
    console.log('Redis: Not configured, using in-memory fallback (caching disabled)');
    return new NoOpRedisClient();
  }

  console.log(`Redis: Connecting to ${redisHost}:${process.env.REDIS_PORT || '6379'}`);
  return new RealRedisClient();
}

export const redis = createRedisClient();
