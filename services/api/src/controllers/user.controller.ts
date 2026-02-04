import { Request, Response } from 'express';
import {
  createUser,
  getUserById,
  getUserByEmail,
  getUserByApixId,
  getUserUsageStats,
  updateUserPlan,
  cancelUserSubscription,
} from '../services/user.service';
import {
  createApiKey,
  getUserApiKeys,
  revokeApiKey,
} from '../services/api-key.service';
import { isValidEmail } from '../utils/validation';

/**
 * Register a new user
 * POST /api/v1/users/register
 */
export async function registerUser(req: Request, res: Response): Promise<void> {
  try {
    const { email, fullName, companyName, plan } = req.body;

    // RFC 5322 compliant email validation
    if (!email || !isValidEmail(email)) {
      res.status(400).json({
        error: 'Invalid email address',
        message: 'Please provide a valid email address (RFC 5322 compliant)',
      });
      return;
    }

    // Check if user already exists
    const existingUser = await getUserByEmail(email);
    if (existingUser) {
      res.status(409).json({
        error: 'User already exists',
        message: 'A user with this email already exists',
      });
      return;
    }

    // Create user with subscription and API key
    const { user, subscription, apiKey } = await createUser({
      email,
      fullName,
      companyName,
      plan: plan || 'starter',
    });

    res.status(201).json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        plan: user.subscriptionPlan,
      },
      subscription: {
        plan: subscription.plan,
        monthlyQuota: subscription.monthlyQuota,
        rateLimitPerMinute: subscription.rateLimitPerMinute,
        billingPeriodEnd: subscription.billingPeriodEnd,
      },
      apiKey: {
        key: apiKey.key, // IMPORTANT: Show this only once!
        keyPrefix: apiKey.keyPrefix,
        warning: 'Save this API key securely. You will not be able to see it again!',
      },
    });
  } catch (error) {
    console.error('User registration error:', error);
    res.status(500).json({
      error: 'Registration failed',
      message: error instanceof Error ? error.message : 'Internal server error',
    });
  }
}

/**
 * Get current user info
 * GET /api/v1/users/me
 */
export async function getCurrentUser(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.apiKeyData?.user_id;

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const user = await getUserById(userId);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.json({
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      companyName: user.companyName,
      plan: user.subscriptionPlan,
      status: user.subscriptionStatus,
      createdAt: user.createdAt,
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to get user information' });
  }
}

/**
 * Get user's usage statistics
 * GET /api/v1/users/usage
 */
export async function getUserUsage(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.apiKeyData?.user_id;

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const stats = await getUserUsageStats(userId);

    if (!stats) {
      res.status(404).json({ error: 'Usage statistics not found' });
      return;
    }

    res.json({
      currentUsage: stats.currentUsage,
      monthlyQuota: stats.monthlyQuota,
      usagePercentage: stats.usagePercentage,
      remaining: stats.monthlyQuota - stats.currentUsage,
      rateLimitPerMinute: stats.rateLimitPerMinute,
      billingPeriod: {
        start: stats.billingPeriodStart,
        end: stats.billingPeriodEnd,
        daysUntilReset: stats.daysUntilReset,
      },
    });
  } catch (error) {
    console.error('Get usage error:', error);
    res.status(500).json({ error: 'Failed to get usage statistics' });
  }
}

/**
 * Get user's API keys
 * GET /api/v1/users/keys
 */
export async function getMyApiKeys(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.apiKeyData?.user_id;

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const keys = await getUserApiKeys(userId);

    res.json({
      keys: keys.map(key => ({
        id: key.id,
        keyPrefix: key.keyPrefix,
        name: key.name,
        active: key.active,
        totalCalls: key.totalCalls,
        lastUsedAt: key.lastUsedAt,
        createdAt: key.createdAt,
      })),
    });
  } catch (error) {
    console.error('Get API keys error:', error);
    res.status(500).json({ error: 'Failed to get API keys' });
  }
}

/**
 * Generate a new API key
 * POST /api/v1/users/keys
 */
export async function generateNewApiKey(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.apiKeyData?.user_id;
    const { name } = req.body;

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const apiKey = await createApiKey(userId, name);

    res.status(201).json({
      success: true,
      apiKey: {
        key: apiKey.key, // IMPORTANT: Show only once!
        keyPrefix: apiKey.keyPrefix,
        name,
        warning: 'Save this API key securely. You will not be able to see it again!',
      },
    });
  } catch (error) {
    console.error('Generate API key error:', error);
    res.status(500).json({ error: 'Failed to generate API key' });
  }
}

/**
 * Revoke an API key
 * DELETE /api/v1/users/keys/:keyId
 */
export async function deleteApiKey(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.apiKeyData?.user_id;
    const { keyId } = req.params;

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const revoked = await revokeApiKey(keyId, userId);

    if (!revoked) {
      res.status(404).json({ error: 'API key not found' });
      return;
    }

    res.json({
      success: true,
      message: 'API key revoked successfully',
    });
  } catch (error) {
    console.error('Revoke API key error:', error);
    res.status(500).json({ error: 'Failed to revoke API key' });
  }
}

/**
 * Update user's subscription plan
 * POST /api/v1/users/plan
 */
export async function updatePlan(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.apiKeyData?.user_id;
    const { plan } = req.body;

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    if (!['starter', 'pro', 'enterprise'].includes(plan)) {
      res.status(400).json({
        error: 'Invalid plan',
        message: 'Plan must be one of: starter, pro, enterprise',
      });
      return;
    }

    const subscription = await updateUserPlan(userId, plan);

    res.json({
      success: true,
      subscription: {
        plan: subscription.plan,
        monthlyQuota: subscription.monthlyQuota,
        rateLimitPerMinute: subscription.rateLimitPerMinute,
        priceCents: subscription.priceCents,
      },
    });
  } catch (error) {
    console.error('Update plan error:', error);
    res.status(500).json({ error: 'Failed to update plan' });
  }
}

/**
 * Cancel subscription
 * POST /api/v1/users/cancel
 */
export async function cancelSubscription(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.apiKeyData?.user_id;

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    await cancelUserSubscription(userId);

    res.json({
      success: true,
      message: 'Subscription cancelled successfully',
    });
  } catch (error) {
    console.error('Cancel subscription error:', error);
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
}
