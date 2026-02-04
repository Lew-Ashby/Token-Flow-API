import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { db } from '../utils/database';
import {
  createUser,
  getUserByApixId,
  updateUserPlan,
  cancelUserSubscription,
} from '../services/user.service';
import { createApiKey } from '../services/api-key.service';
import { isValidEmail } from '../utils/validation';

/**
 * APIX Webhook Handler
 * POST /webhooks/apix
 *
 * Handles webhooks from APIX marketplace for:
 * - user.subscribed: New user subscription
 * - user.plan_changed: User upgraded/downgraded plan
 * - user.cancelled: User cancelled subscription
 * - user.renewed: Subscription renewed (reset usage)
 */
export async function handleApixWebhook(req: Request, res: Response): Promise<void> {
  try {
    const { event, data } = req.body;

    // Log webhook for debugging
    console.log('APIX Webhook received:', { event, data });

    // Store webhook in database for audit trail
    await db.query(
      `INSERT INTO webhook_events (source, event_type, payload, received_at)
       VALUES ('apix', $1, $2, NOW())`,
      [event, JSON.stringify(req.body)]
    );

    // Handle different event types
    switch (event) {
      case 'user.subscribed':
        await handleUserSubscribed(data, res);
        break;

      case 'user.plan_changed':
        await handlePlanChanged(data, res);
        break;

      case 'user.cancelled':
        await handleUserCancelled(data, res);
        break;

      case 'user.renewed':
        await handleSubscriptionRenewed(data, res);
        break;

      default:
        console.warn('Unknown webhook event:', event);
        res.status(200).json({
          success: true,
          message: 'Webhook received but event type not handled',
        });
    }
  } catch (error) {
    console.error('Webhook processing error:', error);

    // Update webhook event with error
    try {
      await db.query(
        `UPDATE webhook_events
         SET processed = false, error_message = $1
         WHERE payload = $2
         ORDER BY received_at DESC
         LIMIT 1`,
        [error instanceof Error ? error.message : 'Unknown error', JSON.stringify(req.body)]
      );
    } catch (dbError) {
      console.error('Failed to update webhook event:', dbError);
    }

    res.status(500).json({
      success: false,
      error: 'Webhook processing failed',
      message: error instanceof Error ? error.message : 'Internal server error',
    });
  }
}

/**
 * Handle new user subscription
 */
async function handleUserSubscribed(data: any, res: Response): Promise<void> {
  const { apixUserId, email, fullName, companyName, plan } = data;

  // Validate required fields
  if (!apixUserId || !email) {
    res.status(400).json({
      success: false,
      error: 'Missing required fields',
      message: 'apixUserId and email are required',
    });
    return;
  }

  // Validate email format (RFC 5322 compliant)
  if (!isValidEmail(email)) {
    res.status(400).json({
      success: false,
      error: 'Invalid email address',
      message: 'Please provide a valid RFC 5322 compliant email address',
    });
    return;
  }

  // Check if user already exists
  const existingUser = await getUserByApixId(apixUserId);

  if (existingUser) {
    res.status(200).json({
      success: true,
      message: 'User already exists',
      userId: existingUser.id,
    });
    return;
  }

  // Create new user with subscription and API key
  const { user, subscription, apiKey } = await createUser({
    email,
    fullName,
    companyName,
    plan: plan || 'starter',
    apixUserId,
  });

  // Mark webhook as processed
  await db.query(
    `UPDATE webhook_events
     SET processed = true, processed_at = NOW()
     WHERE payload->>'apixUserId' = $1
       AND event_type = 'user.subscribed'
     ORDER BY received_at DESC
     LIMIT 1`,
    [apixUserId]
  );

  // SECURITY: Only send key prefix to APIX, not full key
  // APIX should handle delivering the full key to the end user through their secure channel
  res.status(201).json({
    success: true,
    message: 'User created successfully',
    user: {
      id: user.id,
      email: user.email,
      apixUserId: user.apixUserId,
    },
    subscription: {
      plan: subscription.plan,
      monthlyQuota: subscription.monthlyQuota,
      rateLimitPerMinute: subscription.rateLimitPerMinute,
    },
    apiKey: {
      keyPrefix: apiKey.keyPrefix, // Only send prefix for reference
      message: 'API key generated. User should retrieve it through APIX secure channel.',
    },
  });
}

/**
 * Handle plan change (upgrade/downgrade)
 */
async function handlePlanChanged(data: any, res: Response): Promise<void> {
  const { apixUserId, newPlan } = data;

  if (!apixUserId || !newPlan) {
    res.status(400).json({
      success: false,
      error: 'Missing required fields',
      message: 'apixUserId and newPlan are required',
    });
    return;
  }

  const user = await getUserByApixId(apixUserId);

  if (!user) {
    res.status(404).json({
      success: false,
      error: 'User not found',
      message: `No user found with apixUserId: ${apixUserId}`,
    });
    return;
  }

  // Update user's plan
  const subscription = await updateUserPlan(user.id, newPlan);

  // Mark webhook as processed
  await db.query(
    `UPDATE webhook_events
     SET processed = true, processed_at = NOW()
     WHERE payload->>'apixUserId' = $1
       AND event_type = 'user.plan_changed'
     ORDER BY received_at DESC
     LIMIT 1`,
    [apixUserId]
  );

  res.json({
    success: true,
    message: 'Plan updated successfully',
    subscription: {
      plan: subscription.plan,
      monthlyQuota: subscription.monthlyQuota,
      rateLimitPerMinute: subscription.rateLimitPerMinute,
    },
  });
}

/**
 * Handle subscription cancellation
 */
async function handleUserCancelled(data: any, res: Response): Promise<void> {
  const { apixUserId } = data;

  if (!apixUserId) {
    res.status(400).json({
      success: false,
      error: 'Missing required field',
      message: 'apixUserId is required',
    });
    return;
  }

  const user = await getUserByApixId(apixUserId);

  if (!user) {
    res.status(404).json({
      success: false,
      error: 'User not found',
      message: `No user found with apixUserId: ${apixUserId}`,
    });
    return;
  }

  // Cancel subscription
  await cancelUserSubscription(user.id);

  // Mark webhook as processed
  await db.query(
    `UPDATE webhook_events
     SET processed = true, processed_at = NOW()
     WHERE payload->>'apixUserId' = $1
       AND event_type = 'user.cancelled'
     ORDER BY received_at DESC
     LIMIT 1`,
    [apixUserId]
  );

  res.json({
    success: true,
    message: 'Subscription cancelled successfully',
  });
}

/**
 * Handle subscription renewal (reset usage)
 */
async function handleSubscriptionRenewed(data: any, res: Response): Promise<void> {
  const { apixUserId } = data;

  if (!apixUserId) {
    res.status(400).json({
      success: false,
      error: 'Missing required field',
      message: 'apixUserId is required',
    });
    return;
  }

  const user = await getUserByApixId(apixUserId);

  if (!user) {
    res.status(404).json({
      success: false,
      error: 'User not found',
      message: `No user found with apixUserId: ${apixUserId}`,
    });
    return;
  }

  // Reset usage and update billing period
  await db.query('SELECT reset_monthly_usage()');

  // Mark webhook as processed
  await db.query(
    `UPDATE webhook_events
     SET processed = true, processed_at = NOW()
     WHERE payload->>'apixUserId' = $1
       AND event_type = 'user.renewed'
     ORDER BY received_at DESC
     LIMIT 1`,
    [apixUserId]
  );

  res.json({
    success: true,
    message: 'Subscription renewed and usage reset',
  });
}

/**
 * Verify webhook signature from APIX
 * CRITICAL SECURITY: Prevents unauthorized webhook spoofing
 */
export function verifyWebhookSignature(req: Request, res: Response, next: NextFunction): void {
  const signature = req.headers['x-webhook-signature'] as string;
  const secret = process.env.APIX_WEBHOOK_SECRET;

  // Validate secret is configured
  if (!secret) {
    console.error('CRITICAL: APIX_WEBHOOK_SECRET not configured!');
    res.status(500).json({
      error: 'Webhook configuration error',
      message: 'Server misconfiguration - webhook secret not set',
    });
    return;
  }

  // Validate signature is provided
  if (!signature) {
    console.warn('Webhook received without signature', {
      ip: req.ip,
      timestamp: new Date().toISOString(),
    });
    res.status(401).json({
      error: 'Missing webhook signature',
      message: 'x-webhook-signature header is required',
    });
    return;
  }

  // Verify signature using HMAC-SHA256
  try {
    const payload = JSON.stringify(req.body);
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(payload)
      .digest('hex');

    // Constant-time comparison to prevent timing attacks
    const isValid = crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );

    if (!isValid) {
      console.warn('Invalid webhook signature detected', {
        ip: req.ip,
        receivedSignature: signature.substring(0, 8) + '...',
        timestamp: new Date().toISOString(),
      });
      res.status(401).json({
        error: 'Invalid webhook signature',
        message: 'Signature verification failed',
      });
      return;
    }

    // Signature valid - proceed
    next();
  } catch (error) {
    console.error('Webhook signature verification error:', error);
    res.status(500).json({
      error: 'Signature verification failed',
      message: 'Internal server error during verification',
    });
  }
}
