import request from 'supertest';
import { app } from '../../src/index';
import { db } from '../../src/utils/database';
import crypto from 'crypto';

describe('APIX Webhook Integration Tests', () => {
  const WEBHOOK_SECRET = process.env.APIX_WEBHOOK_SECRET || 'test_webhook_secret';

  function generateWebhookSignature(payload: any): string {
    return crypto
      .createHmac('sha256', WEBHOOK_SECRET)
      .update(JSON.stringify(payload))
      .digest('hex');
  }

  afterAll(async () => {
    // Cleanup test users created by webhooks
    await db.query('DELETE FROM users WHERE email LIKE $1', ['apix-test-%@example.com']);
    await db.end();
  });

  describe('POST /webhooks/apix', () => {
    describe('user.subscribed event', () => {
      it('should create new user and return API key', async () => {
        const payload = {
          event: 'user.subscribed',
          data: {
            apixUserId: `apix-${Date.now()}`,
            email: `apix-test-${Date.now()}@example.com`,
            plan: 'pro',
            metadata: {
              fullName: 'APIX Test User',
              companyName: 'APIX Test Company',
            },
          },
          timestamp: new Date().toISOString(),
        };

        const signature = generateWebhookSignature(payload);

        const response = await request(app)
          .post('/webhooks/apix')
          .set('x-webhook-signature', signature)
          .send(payload)
          .expect(200);

        expect(response.body.success).toBe(true);
        expect(response.body.apiKey).toBeDefined();
        expect(response.body.apiKey).toMatch(/^tfa_live_[a-f0-9]{64}$/);
        expect(response.body.user).toBeDefined();
        expect(response.body.user.email).toBe(payload.data.email);
        expect(response.body.user.plan).toBe('pro');

        // Verify user was created in database
        const userCheck = await db.query(
          'SELECT * FROM users WHERE apix_user_id = $1',
          [payload.data.apixUserId]
        );

        expect(userCheck.rows.length).toBe(1);
        expect(userCheck.rows[0].email).toBe(payload.data.email);
        expect(userCheck.rows[0].subscription_plan).toBe('pro');
      });

      it('should reject webhook without signature', async () => {
        const payload = {
          event: 'user.subscribed',
          data: {
            apixUserId: `apix-${Date.now()}`,
            email: `test-${Date.now()}@example.com`,
            plan: 'starter',
          },
          timestamp: new Date().toISOString(),
        };

        const response = await request(app)
          .post('/webhooks/apix')
          .send(payload)
          .expect(401);

        expect(response.body.error).toContain('signature');
      });

      it('should reject webhook with invalid signature', async () => {
        const payload = {
          event: 'user.subscribed',
          data: {
            apixUserId: `apix-${Date.now()}`,
            email: `test-${Date.now()}@example.com`,
            plan: 'starter',
          },
          timestamp: new Date().toISOString(),
        };

        const response = await request(app)
          .post('/webhooks/apix')
          .set('x-webhook-signature', 'invalid_signature_12345')
          .send(payload)
          .expect(401);

        expect(response.body.error).toContain('Invalid signature');
      });

      it('should create user with enterprise plan', async () => {
        const payload = {
          event: 'user.subscribed',
          data: {
            apixUserId: `apix-enterprise-${Date.now()}`,
            email: `apix-enterprise-${Date.now()}@example.com`,
            plan: 'enterprise',
            metadata: {
              fullName: 'Enterprise User',
            },
          },
          timestamp: new Date().toISOString(),
        };

        const signature = generateWebhookSignature(payload);

        const response = await request(app)
          .post('/webhooks/apix')
          .set('x-webhook-signature', signature)
          .send(payload)
          .expect(200);

        expect(response.body.user.plan).toBe('enterprise');

        // Verify subscription has enterprise limits
        const subCheck = await db.query(
          'SELECT * FROM subscriptions WHERE user_id = $1',
          [response.body.user.id]
        );

        expect(subCheck.rows[0].plan).toBe('enterprise');
        expect(parseInt(subCheck.rows[0].monthly_quota)).toBe(100000);
        expect(parseInt(subCheck.rows[0].rate_limit_per_minute)).toBe(300);
      });
    });

    describe('user.plan_changed event', () => {
      let testApixUserId: string;
      let testUserId: string;

      beforeAll(async () => {
        // Create a test user via webhook
        testApixUserId = `apix-plan-change-${Date.now()}`;
        const payload = {
          event: 'user.subscribed',
          data: {
            apixUserId: testApixUserId,
            email: `apix-plan-${Date.now()}@example.com`,
            plan: 'starter',
          },
          timestamp: new Date().toISOString(),
        };

        const signature = generateWebhookSignature(payload);
        const response = await request(app)
          .post('/webhooks/apix')
          .set('x-webhook-signature', signature)
          .send(payload);

        testUserId = response.body.user.id;
      });

      it('should upgrade user plan from starter to pro', async () => {
        const payload = {
          event: 'user.plan_changed',
          data: {
            apixUserId: testApixUserId,
            newPlan: 'pro',
            oldPlan: 'starter',
          },
          timestamp: new Date().toISOString(),
        };

        const signature = generateWebhookSignature(payload);

        const response = await request(app)
          .post('/webhooks/apix')
          .set('x-webhook-signature', signature)
          .send(payload)
          .expect(200);

        expect(response.body.success).toBe(true);
        expect(response.body.subscription.plan).toBe('pro');
        expect(response.body.subscription.monthlyQuota).toBe(10000);

        // Verify in database
        const userCheck = await db.query(
          'SELECT subscription_plan FROM users WHERE apix_user_id = $1',
          [testApixUserId]
        );

        expect(userCheck.rows[0].subscription_plan).toBe('pro');
      });

      it('should upgrade to enterprise plan', async () => {
        const payload = {
          event: 'user.plan_changed',
          data: {
            apixUserId: testApixUserId,
            newPlan: 'enterprise',
            oldPlan: 'pro',
          },
          timestamp: new Date().toISOString(),
        };

        const signature = generateWebhookSignature(payload);

        const response = await request(app)
          .post('/webhooks/apix')
          .set('x-webhook-signature', signature)
          .send(payload)
          .expect(200);

        expect(response.body.subscription.plan).toBe('enterprise');
        expect(response.body.subscription.monthlyQuota).toBe(100000);
      });

      it('should handle plan downgrade', async () => {
        const payload = {
          event: 'user.plan_changed',
          data: {
            apixUserId: testApixUserId,
            newPlan: 'starter',
            oldPlan: 'enterprise',
          },
          timestamp: new Date().toISOString(),
        };

        const signature = generateWebhookSignature(payload);

        const response = await request(app)
          .post('/webhooks/apix')
          .set('x-webhook-signature', signature)
          .send(payload)
          .expect(200);

        expect(response.body.subscription.plan).toBe('starter');
        expect(response.body.subscription.monthlyQuota).toBe(1000);
      });

      it('should return 404 for non-existent APIX user', async () => {
        const payload = {
          event: 'user.plan_changed',
          data: {
            apixUserId: 'non-existent-apix-user-id',
            newPlan: 'pro',
            oldPlan: 'starter',
          },
          timestamp: new Date().toISOString(),
        };

        const signature = generateWebhookSignature(payload);

        const response = await request(app)
          .post('/webhooks/apix')
          .set('x-webhook-signature', signature)
          .send(payload)
          .expect(404);

        expect(response.body.error).toContain('User not found');
      });
    });

    describe('user.cancelled event', () => {
      let cancelTestApixUserId: string;

      beforeAll(async () => {
        // Create a test user
        cancelTestApixUserId = `apix-cancel-${Date.now()}`;
        const payload = {
          event: 'user.subscribed',
          data: {
            apixUserId: cancelTestApixUserId,
            email: `apix-cancel-${Date.now()}@example.com`,
            plan: 'pro',
          },
          timestamp: new Date().toISOString(),
        };

        const signature = generateWebhookSignature(payload);
        await request(app)
          .post('/webhooks/apix')
          .set('x-webhook-signature', signature)
          .send(payload);
      });

      it('should cancel user subscription', async () => {
        const payload = {
          event: 'user.cancelled',
          data: {
            apixUserId: cancelTestApixUserId,
            reason: 'user_requested',
          },
          timestamp: new Date().toISOString(),
        };

        const signature = generateWebhookSignature(payload);

        const response = await request(app)
          .post('/webhooks/apix')
          .set('x-webhook-signature', signature)
          .send(payload)
          .expect(200);

        expect(response.body.success).toBe(true);
        expect(response.body.message).toContain('cancelled');

        // Verify subscription is cancelled
        const userCheck = await db.query(
          'SELECT subscription_status FROM users WHERE apix_user_id = $1',
          [cancelTestApixUserId]
        );

        expect(userCheck.rows[0].subscription_status).toBe('cancelled');

        // Verify subscription record is cancelled
        const subCheck = await db.query(
          `SELECT status, cancelled_at FROM subscriptions
           WHERE user_id = (SELECT id FROM users WHERE apix_user_id = $1)`,
          [cancelTestApixUserId]
        );

        expect(subCheck.rows[0].status).toBe('cancelled');
        expect(subCheck.rows[0].cancelled_at).not.toBeNull();
      });
    });

    describe('user.renewed event', () => {
      let renewTestApixUserId: string;

      beforeAll(async () => {
        // Create and cancel a test user
        renewTestApixUserId = `apix-renew-${Date.now()}`;
        const createPayload = {
          event: 'user.subscribed',
          data: {
            apixUserId: renewTestApixUserId,
            email: `apix-renew-${Date.now()}@example.com`,
            plan: 'starter',
          },
          timestamp: new Date().toISOString(),
        };

        const createSig = generateWebhookSignature(createPayload);
        await request(app)
          .post('/webhooks/apix')
          .set('x-webhook-signature', createSig)
          .send(createPayload);

        // Cancel the subscription
        const cancelPayload = {
          event: 'user.cancelled',
          data: {
            apixUserId: renewTestApixUserId,
            reason: 'test_setup',
          },
          timestamp: new Date().toISOString(),
        };

        const cancelSig = generateWebhookSignature(cancelPayload);
        await request(app)
          .post('/webhooks/apix')
          .set('x-webhook-signature', cancelSig)
          .send(cancelPayload);
      });

      it('should reactivate cancelled subscription', async () => {
        const payload = {
          event: 'user.renewed',
          data: {
            apixUserId: renewTestApixUserId,
            plan: 'pro',
          },
          timestamp: new Date().toISOString(),
        };

        const signature = generateWebhookSignature(payload);

        const response = await request(app)
          .post('/webhooks/apix')
          .set('x-webhook-signature', signature)
          .send(payload)
          .expect(200);

        expect(response.body.success).toBe(true);
        expect(response.body.subscription.plan).toBe('pro');
        expect(response.body.subscription.status).toBe('active');

        // Verify in database
        const userCheck = await db.query(
          'SELECT subscription_status FROM users WHERE apix_user_id = $1',
          [renewTestApixUserId]
        );

        expect(userCheck.rows[0].subscription_status).toBe('active');
      });

      it('should reset usage counter on renewal', async () => {
        // Verify usage was reset
        const userId = await db.query(
          'SELECT id FROM users WHERE apix_user_id = $1',
          [renewTestApixUserId]
        );

        const subCheck = await db.query(
          'SELECT current_usage FROM subscriptions WHERE user_id = $1 AND status = $2',
          [userId.rows[0].id, 'active']
        );

        expect(parseInt(subCheck.rows[0].current_usage)).toBe(0);
      });
    });

    describe('Webhook logging and idempotency', () => {
      it('should log webhook events', async () => {
        const payload = {
          event: 'user.subscribed',
          data: {
            apixUserId: `apix-log-${Date.now()}`,
            email: `apix-log-${Date.now()}@example.com`,
            plan: 'starter',
          },
          timestamp: new Date().toISOString(),
        };

        const signature = generateWebhookSignature(payload);

        await request(app)
          .post('/webhooks/apix')
          .set('x-webhook-signature', signature)
          .send(payload)
          .expect(200);

        // Verify webhook was logged
        const logCheck = await db.query(
          'SELECT * FROM webhook_events WHERE apix_user_id = $1',
          [payload.data.apixUserId]
        );

        expect(logCheck.rows.length).toBeGreaterThan(0);
        expect(logCheck.rows[0].event_type).toBe('user.subscribed');
        expect(logCheck.rows[0].processed).toBe(true);
      });

      it('should handle unknown event types gracefully', async () => {
        const payload = {
          event: 'user.unknown_event',
          data: {
            apixUserId: `apix-unknown-${Date.now()}`,
          },
          timestamp: new Date().toISOString(),
        };

        const signature = generateWebhookSignature(payload);

        const response = await request(app)
          .post('/webhooks/apix')
          .set('x-webhook-signature', signature)
          .send(payload)
          .expect(400);

        expect(response.body.error).toContain('Unknown event type');
      });
    });

    describe('Webhook security', () => {
      it('should reject replay attacks with old timestamps', async () => {
        const oldTimestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 minutes ago

        const payload = {
          event: 'user.subscribed',
          data: {
            apixUserId: `apix-replay-${Date.now()}`,
            email: `replay-${Date.now()}@example.com`,
            plan: 'starter',
          },
          timestamp: oldTimestamp,
        };

        const signature = generateWebhookSignature(payload);

        const response = await request(app)
          .post('/webhooks/apix')
          .set('x-webhook-signature', signature)
          .send(payload)
          .expect(401);

        expect(response.body.error).toContain('expired');
      });

      it('should require content-type application/json', async () => {
        const payload = {
          event: 'user.subscribed',
          data: {
            apixUserId: `apix-content-${Date.now()}`,
            email: `content-${Date.now()}@example.com`,
            plan: 'starter',
          },
          timestamp: new Date().toISOString(),
        };

        const signature = generateWebhookSignature(payload);

        const response = await request(app)
          .post('/webhooks/apix')
          .set('x-webhook-signature', signature)
          .set('content-type', 'text/plain')
          .send(JSON.stringify(payload))
          .expect(415);

        expect(response.body.error).toContain('Content-Type');
      });
    });
  });
});
