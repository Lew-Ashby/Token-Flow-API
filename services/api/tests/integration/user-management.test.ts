import request from 'supertest';
import { app } from '../../src/index';
import { db } from '../../src/utils/database';
import crypto from 'crypto';

describe('User Management Integration Tests', () => {
  let testUserId: string;
  let testApiKey: string;
  let testEmail: string;

  beforeAll(async () => {
    // Ensure database is connected
    await db.query('SELECT 1');
  });

  afterAll(async () => {
    // Cleanup test data
    if (testUserId) {
      await db.query('DELETE FROM api_keys WHERE user_id = $1', [testUserId]);
      await db.query('DELETE FROM subscriptions WHERE user_id = $1', [testUserId]);
      await db.query('DELETE FROM users WHERE id = $1', [testUserId]);
    }
    await db.end();
  });

  describe('POST /api/v1/users/register', () => {
    it('should register a new user with starter plan', async () => {
      testEmail = `test-${Date.now()}@example.com`;

      const response = await request(app)
        .post('/api/v1/users/register')
        .send({
          email: testEmail,
          fullName: 'Test User',
          companyName: 'Test Company',
          plan: 'starter',
        })
        .expect(201);

      expect(response.body.success).toBe(true);
      expect(response.body.user).toBeDefined();
      expect(response.body.user.email).toBe(testEmail);
      expect(response.body.user.plan).toBe('starter');

      expect(response.body.subscription).toBeDefined();
      expect(response.body.subscription.monthlyQuota).toBe(1000);
      expect(response.body.subscription.rateLimitPerMinute).toBe(10);

      expect(response.body.apiKey).toBeDefined();
      expect(response.body.apiKey.key).toMatch(/^tfa_live_[a-f0-9]{64}$/);
      expect(response.body.apiKey.warning).toContain('Save this API key');

      // Store for subsequent tests
      testUserId = response.body.user.id;
      testApiKey = response.body.apiKey.key;
    });

    it('should register a new user with pro plan', async () => {
      const proEmail = `pro-${Date.now()}@example.com`;

      const response = await request(app)
        .post('/api/v1/users/register')
        .send({
          email: proEmail,
          fullName: 'Pro User',
          plan: 'pro',
        })
        .expect(201);

      expect(response.body.subscription.plan).toBe('pro');
      expect(response.body.subscription.monthlyQuota).toBe(10000);
      expect(response.body.subscription.rateLimitPerMinute).toBe(60);

      // Cleanup
      await db.query('DELETE FROM api_keys WHERE user_id = $1', [response.body.user.id]);
      await db.query('DELETE FROM subscriptions WHERE user_id = $1', [response.body.user.id]);
      await db.query('DELETE FROM users WHERE id = $1', [response.body.user.id]);
    });

    it('should reject registration with invalid email', async () => {
      const response = await request(app)
        .post('/api/v1/users/register')
        .send({
          email: 'invalid-email',
          fullName: 'Test User',
        })
        .expect(400);

      expect(response.body.error).toContain('Invalid email');
    });

    it('should reject duplicate email registration', async () => {
      const response = await request(app)
        .post('/api/v1/users/register')
        .send({
          email: testEmail,
          fullName: 'Duplicate User',
        })
        .expect(409);

      expect(response.body.error).toContain('already exists');
    });
  });

  describe('GET /api/v1/users/me', () => {
    it('should return current user information', async () => {
      const response = await request(app)
        .get('/api/v1/users/me')
        .set('x-api-key', testApiKey)
        .expect(200);

      expect(response.body.id).toBe(testUserId);
      expect(response.body.email).toBe(testEmail);
      expect(response.body.fullName).toBe('Test User');
      expect(response.body.companyName).toBe('Test Company');
      expect(response.body.plan).toBe('starter');
      expect(response.body.status).toBe('active');
    });

    it('should reject request without API key', async () => {
      const response = await request(app)
        .get('/api/v1/users/me')
        .expect(401);

      expect(response.body.error).toContain('API key required');
    });

    it('should reject request with invalid API key', async () => {
      const response = await request(app)
        .get('/api/v1/users/me')
        .set('x-api-key', 'tfa_live_invalid1234567890abcdef')
        .expect(401);

      expect(response.body.error).toContain('Invalid API key');
    });
  });

  describe('GET /api/v1/users/usage', () => {
    it('should return usage statistics', async () => {
      const response = await request(app)
        .get('/api/v1/users/usage')
        .set('x-api-key', testApiKey)
        .expect(200);

      expect(response.body.currentUsage).toBeDefined();
      expect(response.body.monthlyQuota).toBe(1000);
      expect(response.body.usagePercentage).toBeDefined();
      expect(response.body.remaining).toBeDefined();
      expect(response.body.rateLimitPerMinute).toBe(10);
      expect(response.body.billingPeriod).toBeDefined();
      expect(response.body.billingPeriod.start).toBeDefined();
      expect(response.body.billingPeriod.end).toBeDefined();
      expect(response.body.billingPeriod.daysUntilReset).toBeGreaterThan(0);
    });

    it('should show increased usage after API calls', async () => {
      // Get initial usage
      const before = await request(app)
        .get('/api/v1/users/usage')
        .set('x-api-key', testApiKey)
        .expect(200);

      const initialUsage = before.body.currentUsage;

      // Make a tracked API call (e.g., analyze path)
      await request(app)
        .post('/api/v1/analyze/path')
        .set('x-api-key', testApiKey)
        .send({
          address: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
          token: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          maxDepth: 3,
        });

      // Get updated usage
      const after = await request(app)
        .get('/api/v1/users/usage')
        .set('x-api-key', testApiKey)
        .expect(200);

      expect(after.body.currentUsage).toBeGreaterThan(initialUsage);
    });
  });

  describe('GET /api/v1/users/keys', () => {
    it('should return list of API keys', async () => {
      const response = await request(app)
        .get('/api/v1/users/keys')
        .set('x-api-key', testApiKey)
        .expect(200);

      expect(response.body.keys).toBeDefined();
      expect(Array.isArray(response.body.keys)).toBe(true);
      expect(response.body.keys.length).toBeGreaterThan(0);

      const firstKey = response.body.keys[0];
      expect(firstKey.id).toBeDefined();
      expect(firstKey.keyPrefix).toMatch(/^tfa_live_/);
      expect(firstKey.name).toBe('Default Key');
      expect(firstKey.active).toBe(true);
      expect(firstKey.totalCalls).toBeGreaterThanOrEqual(0);
      expect(firstKey.createdAt).toBeDefined();

      // Should NOT return full key
      expect(firstKey.key).toBeUndefined();
      expect(firstKey.keyHash).toBeUndefined();
    });
  });

  describe('POST /api/v1/users/keys', () => {
    let newApiKeyId: string;

    it('should generate a new API key', async () => {
      const response = await request(app)
        .post('/api/v1/users/keys')
        .set('x-api-key', testApiKey)
        .send({
          name: 'Test Secondary Key',
        })
        .expect(201);

      expect(response.body.success).toBe(true);
      expect(response.body.apiKey).toBeDefined();
      expect(response.body.apiKey.key).toMatch(/^tfa_live_[a-f0-9]{64}$/);
      expect(response.body.apiKey.keyPrefix).toMatch(/^tfa_live_/);
      expect(response.body.apiKey.name).toBe('Test Secondary Key');
      expect(response.body.apiKey.warning).toContain('Save this API key');

      // Store key ID for deletion test
      newApiKeyId = response.body.apiKey.key;
    });

    it('should allow using newly generated key', async () => {
      // First generate a new key
      const createResponse = await request(app)
        .post('/api/v1/users/keys')
        .set('x-api-key', testApiKey)
        .send({ name: 'Verification Key' })
        .expect(201);

      const newKey = createResponse.body.apiKey.key;

      // Use new key to access API
      const response = await request(app)
        .get('/api/v1/users/me')
        .set('x-api-key', newKey)
        .expect(200);

      expect(response.body.email).toBe(testEmail);
    });

    afterAll(async () => {
      // Cleanup secondary keys
      await db.query(
        'DELETE FROM api_keys WHERE user_id = $1 AND name != $2',
        [testUserId, 'Default Key']
      );
    });
  });

  describe('DELETE /api/v1/users/keys/:keyId', () => {
    it('should revoke an API key', async () => {
      // First create a key to revoke
      const createResponse = await request(app)
        .post('/api/v1/users/keys')
        .set('x-api-key', testApiKey)
        .send({ name: 'Key to Revoke' })
        .expect(201);

      // Get the key ID
      const keysResponse = await request(app)
        .get('/api/v1/users/keys')
        .set('x-api-key', testApiKey)
        .expect(200);

      const keyToRevoke = keysResponse.body.keys.find(
        (k: any) => k.name === 'Key to Revoke'
      );

      // Revoke the key
      const response = await request(app)
        .delete(`/api/v1/users/keys/${keyToRevoke.id}`)
        .set('x-api-key', testApiKey)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.message).toContain('revoked');

      // Verify key is no longer usable
      const testRevokedKey = createResponse.body.apiKey.key;
      await request(app)
        .get('/api/v1/users/me')
        .set('x-api-key', testRevokedKey)
        .expect(401);
    });

    it('should not allow revoking another user\'s key', async () => {
      // Create another user
      const otherUser = await request(app)
        .post('/api/v1/users/register')
        .send({
          email: `other-${Date.now()}@example.com`,
          fullName: 'Other User',
        })
        .expect(201);

      const otherApiKey = otherUser.body.apiKey.key;

      // Get other user's key ID
      const otherKeys = await request(app)
        .get('/api/v1/users/keys')
        .set('x-api-key', otherApiKey)
        .expect(200);

      const otherKeyId = otherKeys.body.keys[0].id;

      // Try to revoke other user's key using test user's API key
      const response = await request(app)
        .delete(`/api/v1/users/keys/${otherKeyId}`)
        .set('x-api-key', testApiKey)
        .expect(404);

      expect(response.body.error).toContain('not found');

      // Cleanup
      await db.query('DELETE FROM api_keys WHERE user_id = $1', [otherUser.body.user.id]);
      await db.query('DELETE FROM subscriptions WHERE user_id = $1', [otherUser.body.user.id]);
      await db.query('DELETE FROM users WHERE id = $1', [otherUser.body.user.id]);
    });
  });

  describe('POST /api/v1/users/plan', () => {
    it('should upgrade from starter to pro', async () => {
      const response = await request(app)
        .post('/api/v1/users/plan')
        .set('x-api-key', testApiKey)
        .send({ plan: 'pro' })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.subscription.plan).toBe('pro');
      expect(response.body.subscription.monthlyQuota).toBe(10000);
      expect(response.body.subscription.rateLimitPerMinute).toBe(60);
      expect(response.body.subscription.priceCents).toBe(9900);
    });

    it('should upgrade to enterprise plan', async () => {
      const response = await request(app)
        .post('/api/v1/users/plan')
        .set('x-api-key', testApiKey)
        .send({ plan: 'enterprise' })
        .expect(200);

      expect(response.body.subscription.plan).toBe('enterprise');
      expect(response.body.subscription.monthlyQuota).toBe(100000);
      expect(response.body.subscription.rateLimitPerMinute).toBe(300);
    });

    it('should reject invalid plan', async () => {
      const response = await request(app)
        .post('/api/v1/users/plan')
        .set('x-api-key', testApiKey)
        .send({ plan: 'invalid-plan' })
        .expect(400);

      expect(response.body.error).toContain('Invalid plan');
    });

    it('should allow downgrading from enterprise to starter', async () => {
      const response = await request(app)
        .post('/api/v1/users/plan')
        .set('x-api-key', testApiKey)
        .send({ plan: 'starter' })
        .expect(200);

      expect(response.body.subscription.plan).toBe('starter');
      expect(response.body.subscription.monthlyQuota).toBe(1000);
    });
  });

  describe('POST /api/v1/users/cancel', () => {
    it('should cancel subscription', async () => {
      const response = await request(app)
        .post('/api/v1/users/cancel')
        .set('x-api-key', testApiKey)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.message).toContain('cancelled');

      // Verify user status is updated
      const userResponse = await request(app)
        .get('/api/v1/users/me')
        .set('x-api-key', testApiKey)
        .expect(200);

      expect(userResponse.body.status).toBe('cancelled');
    });

    it('should not allow API calls after cancellation', async () => {
      // Try to use API after cancellation
      const response = await request(app)
        .post('/api/v1/analyze/path')
        .set('x-api-key', testApiKey)
        .send({
          address: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
          token: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          maxDepth: 3,
        })
        .expect(401);

      expect(response.body.error).toContain('Subscription inactive');
    });
  });

  describe('Quota Enforcement', () => {
    let limitedUser: any;
    let limitedApiKey: string;

    beforeAll(async () => {
      // Create a user with starter plan (1000 requests/month)
      const response = await request(app)
        .post('/api/v1/users/register')
        .send({
          email: `quota-test-${Date.now()}@example.com`,
          fullName: 'Quota Test User',
          plan: 'starter',
        })
        .expect(201);

      limitedUser = response.body.user;
      limitedApiKey = response.body.apiKey.key;
    });

    afterAll(async () => {
      await db.query('DELETE FROM api_keys WHERE user_id = $1', [limitedUser.id]);
      await db.query('DELETE FROM subscriptions WHERE user_id = $1', [limitedUser.id]);
      await db.query('DELETE FROM users WHERE id = $1', [limitedUser.id]);
    });

    it('should enforce monthly quota limit', async () => {
      // Manually set usage to quota limit
      await db.query(
        'UPDATE subscriptions SET current_usage = monthly_quota WHERE user_id = $1',
        [limitedUser.id]
      );

      // Try to make API call
      const response = await request(app)
        .post('/api/v1/analyze/path')
        .set('x-api-key', limitedApiKey)
        .send({
          address: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
          token: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          maxDepth: 3,
        })
        .expect(429);

      expect(response.body.error).toContain('Quota exceeded');
    });

    it('should include usage headers in responses', async () => {
      // Reset usage
      await db.query(
        'UPDATE subscriptions SET current_usage = 0 WHERE user_id = $1',
        [limitedUser.id]
      );

      const response = await request(app)
        .get('/api/v1/users/usage')
        .set('x-api-key', limitedApiKey)
        .expect(200);

      expect(response.headers['x-ratelimit-limit']).toBeDefined();
      expect(response.headers['x-ratelimit-remaining']).toBeDefined();
      expect(response.headers['x-quota-limit']).toBeDefined();
      expect(response.headers['x-quota-remaining']).toBeDefined();
    });
  });
});
