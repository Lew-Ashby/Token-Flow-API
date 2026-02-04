import { db } from '../utils/database';
import { createApiKey, GeneratedApiKey } from './api-key.service';

export interface User {
  id: string;
  email: string;
  fullName: string | null;
  companyName: string | null;
  subscriptionPlan: string;
  subscriptionStatus: string;
  apixUserId: string | null;
  createdAt: Date;
  lastLoginAt: Date | null;
}

export interface Subscription {
  id: string;
  userId: string;
  plan: string;
  monthlyQuota: number;
  rateLimitPerMinute: number;
  currentUsage: number;
  billingPeriodStart: Date;
  billingPeriodEnd: Date;
  status: string;
  priceCents: number;
}

export interface CreateUserParams {
  email: string;
  fullName?: string;
  companyName?: string;
  plan?: string;
  apixUserId?: string;
}

export interface UsageStats {
  currentUsage: number;
  monthlyQuota: number;
  usagePercentage: number;
  rateLimitPerMinute: number;
  billingPeriodStart: Date;
  billingPeriodEnd: Date;
  daysUntilReset: number;
}

/**
 * Create a new user with subscription and API key
 */
export async function createUser(params: CreateUserParams): Promise<{
  user: User;
  subscription: Subscription;
  apiKey: GeneratedApiKey;
}> {
  const client = await db.getClient();

  try {
    await client.query('BEGIN');

    // Get plan limits
    const planResult = await client.query(
      'SELECT * FROM plan_limits WHERE plan = $1',
      [params.plan || 'starter']
    );

    if (planResult.rows.length === 0) {
      throw new Error(`Plan not found: ${params.plan}`);
    }

    const planLimits = planResult.rows[0];

    // 1. Create user
    const userResult = await client.query(
      `INSERT INTO users (email, full_name, company_name, subscription_plan, subscription_status, apix_user_id)
       VALUES ($1, $2, $3, $4, 'active', $5)
       RETURNING *`,
      [
        params.email,
        params.fullName || null,
        params.companyName || null,
        planLimits.plan,
        params.apixUserId || null,
      ]
    );

    const user = userResult.rows[0];

    // 2. Create subscription
    const billingStart = new Date();
    const billingEnd = new Date();
    billingEnd.setMonth(billingEnd.getMonth() + 1);

    const subscriptionResult = await client.query(
      `INSERT INTO subscriptions (
        user_id, plan, monthly_quota, rate_limit_per_minute,
        current_usage, billing_period_start, billing_period_end,
        status, price_cents
      )
      VALUES ($1, $2, $3, $4, 0, $5, $6, 'active', $7)
      RETURNING *`,
      [
        user.id,
        planLimits.plan,
        planLimits.monthly_quota,
        planLimits.rate_limit_per_minute,
        billingStart,
        billingEnd,
        planLimits.price_cents,
      ]
    );

    const subscription = subscriptionResult.rows[0];

    // 3. Generate API key
    const apiKey = await createApiKey(user.id, 'Default Key');

    await client.query('COMMIT');

    return {
      user: mapUser(user),
      subscription: mapSubscription(subscription),
      apiKey,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Get user by ID
 */
export async function getUserById(userId: string): Promise<User | null> {
  const result = await db.query(
    'SELECT * FROM users WHERE id = $1',
    [userId]
  );

  return result.rows.length > 0 ? mapUser(result.rows[0]) : null;
}

/**
 * Get user by email
 */
export async function getUserByEmail(email: string): Promise<User | null> {
  const result = await db.query(
    'SELECT * FROM users WHERE email = $1',
    [email]
  );

  return result.rows.length > 0 ? mapUser(result.rows[0]) : null;
}

/**
 * Get user by APIX user ID
 */
export async function getUserByApixId(apixUserId: string): Promise<User | null> {
  const result = await db.query(
    'SELECT * FROM users WHERE apix_user_id = $1',
    [apixUserId]
  );

  return result.rows.length > 0 ? mapUser(result.rows[0]) : null;
}

/**
 * Get user's active subscription
 */
export async function getUserSubscription(userId: string): Promise<Subscription | null> {
  const result = await db.query(
    'SELECT * FROM subscriptions WHERE user_id = $1 AND status = $2',
    [userId, 'active']
  );

  return result.rows.length > 0 ? mapSubscription(result.rows[0]) : null;
}

/**
 * Get user's usage statistics
 */
export async function getUserUsageStats(userId: string): Promise<UsageStats | null> {
  const subscription = await getUserSubscription(userId);

  if (!subscription) {
    return null;
  }

  const now = new Date();
  const billingEnd = new Date(subscription.billingPeriodEnd);
  const daysUntilReset = Math.ceil((billingEnd.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

  const usagePercentage = (subscription.currentUsage / subscription.monthlyQuota) * 100;

  return {
    currentUsage: subscription.currentUsage,
    monthlyQuota: subscription.monthlyQuota,
    usagePercentage: Math.round(usagePercentage * 100) / 100,
    rateLimitPerMinute: subscription.rateLimitPerMinute,
    billingPeriodStart: subscription.billingPeriodStart,
    billingPeriodEnd: subscription.billingPeriodEnd,
    daysUntilReset,
  };
}

/**
 * Increment user's usage counter
 */
export async function incrementUserUsage(userId: string): Promise<void> {
  await db.query('SELECT increment_user_usage($1)', [userId]);
}

/**
 * Check if user is over quota
 */
export async function isUserOverQuota(userId: string): Promise<boolean> {
  const result = await db.query('SELECT is_over_quota($1) as over_quota', [userId]);
  return result.rows[0]?.over_quota || false;
}

/**
 * Update user's subscription plan
 */
export async function updateUserPlan(userId: string, newPlan: string): Promise<Subscription> {
  // Get new plan limits
  const planResult = await db.query(
    'SELECT * FROM plan_limits WHERE plan = $1',
    [newPlan]
  );

  if (planResult.rows.length === 0) {
    throw new Error(`Plan not found: ${newPlan}`);
  }

  const planLimits = planResult.rows[0];

  // Update subscription
  const result = await db.query(
    `UPDATE subscriptions
     SET
       plan = $1,
       monthly_quota = $2,
       rate_limit_per_minute = $3,
       price_cents = $4,
       updated_at = NOW()
     WHERE user_id = $5 AND status = 'active'
     RETURNING *`,
    [
      newPlan,
      planLimits.monthly_quota,
      planLimits.rate_limit_per_minute,
      planLimits.price_cents,
      userId,
    ]
  );

  // Update user's subscription_plan field
  await db.query(
    'UPDATE users SET subscription_plan = $1 WHERE id = $2',
    [newPlan, userId]
  );

  return mapSubscription(result.rows[0]);
}

/**
 * Cancel user's subscription
 */
export async function cancelUserSubscription(userId: string): Promise<void> {
  await db.query(
    `UPDATE subscriptions
     SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
     WHERE user_id = $1 AND status = 'active'`,
    [userId]
  );

  await db.query(
    'UPDATE users SET subscription_status = $1 WHERE id = $2',
    ['cancelled', userId]
  );
}

/**
 * Get all active users (admin only)
 */
export async function getAllActiveUsers(): Promise<User[]> {
  const result = await db.query(
    'SELECT * FROM active_users_with_usage ORDER BY created_at DESC LIMIT 100'
  );

  return result.rows.map(mapUser);
}

// Helper functions to map database rows to TypeScript interfaces
function mapUser(row: any): User {
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    companyName: row.company_name,
    subscriptionPlan: row.subscription_plan,
    subscriptionStatus: row.subscription_status,
    apixUserId: row.apix_user_id,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

function mapSubscription(row: any): Subscription {
  return {
    id: row.id,
    userId: row.user_id,
    plan: row.plan,
    monthlyQuota: parseInt(row.monthly_quota),
    rateLimitPerMinute: parseInt(row.rate_limit_per_minute),
    currentUsage: parseInt(row.current_usage) || 0,
    billingPeriodStart: row.billing_period_start,
    billingPeriodEnd: row.billing_period_end,
    status: row.status,
    priceCents: parseInt(row.price_cents),
  };
}
