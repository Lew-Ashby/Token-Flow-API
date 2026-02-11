import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import helmet from 'helmet';
import { v4 as uuidv4 } from 'uuid';
import { authenticateApiKey } from './middleware/auth.middleware';
import { rateLimiter } from './middleware/rate-limit.middleware';
import {
  validateSolanaAddress,
  validateTokenMint,
  validateMaxDepth,
  validateTimeRange,
  validateSignatures,
} from './middleware/validation.middleware';
import { analysisController } from './controllers/analysis.controller';
import { entityService } from './services/entity.service';
import { riskScoringService } from './services/risk-scoring.service';
import * as userController from './controllers/user.controller';
import { handleApixWebhook, verifyWebhookSignature } from './controllers/webhook.controller';
import { usageTrackingMiddleware, addUsageHeaders } from './middleware/usage-tracking.middleware';

dotenv.config();

// Validate critical environment variables at startup
function validateEnvironment(): void {
  const required = ['HELIUS_API_KEY', 'POSTGRES_PASSWORD', 'API_KEY_SALT', 'ADMIN_API_KEY'];
  const missing = required.filter(key => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(`FATAL: Missing required environment variables: ${missing.join(', ')}`);
  }

  // Validate Helius API Key is not the exposed key
  const heliusKey = process.env.HELIUS_API_KEY!;
  const exposedKey = 'ad63db19-f488-4d30-826b-7be5ab395a07';
  const defaultKey = 'your_helius_api_key_here';

  if (heliusKey === exposedKey) {
    throw new Error(
      'FATAL: You are using the EXPOSED Helius API key!\n' +
      '  This key was publicly disclosed and MUST be rotated immediately.\n' +
      '  Get a new key from: https://helius.xyz'
    );
  }

  if (heliusKey === defaultKey) {
    throw new Error('FATAL: HELIUS_API_KEY is not configured. Get your key from https://helius.xyz');
  }

  if (heliusKey.length < 20) {
    throw new Error('FATAL: HELIUS_API_KEY appears to be invalid (too short)');
  }

  // Validate API_KEY_SALT strength
  const salt = process.env.API_KEY_SALT!;
  if (salt === 'default_salt_change_in_production' ||
      salt.includes('change_in_production') ||
      salt === 'your_random_salt_for_api_keys_here') {
    throw new Error('FATAL: API_KEY_SALT must be changed from default value (run: openssl rand -hex 32)');
  }

  if (salt.length < 32) {
    throw new Error('FATAL: API_KEY_SALT must be at least 32 characters (run: openssl rand -hex 32)');
  }

  // Validate Admin API Key
  const adminKey = process.env.ADMIN_API_KEY!;
  if (adminKey === 'your_admin_key_here') {
    throw new Error('FATAL: ADMIN_API_KEY is not configured (run: openssl rand -hex 32)');
  }

  if (adminKey.length < 32) {
    throw new Error('FATAL: ADMIN_API_KEY must be at least 32 characters for security');
  }

  // Validate database password strength
  const dbPassword = process.env.POSTGRES_PASSWORD!;
  const weakPasswords = ['password', '123456', 'admin', 'postgres', 'your_secure_database_password_here'];
  if (weakPasswords.includes(dbPassword)) {
    throw new Error('FATAL: POSTGRES_PASSWORD is too weak. Use a strong randomly generated password.');
  }

  // Production-specific validations
  if (process.env.NODE_ENV === 'production') {
    if (!process.env.ALLOWED_ORIGINS) {
      console.warn(
        '⚠️  WARNING: ALLOWED_ORIGINS not set in production. ' +
        'This allows requests from ANY origin (security risk).'
      );
    }

    if (dbPassword === 'secure_db_password_2026') {
      throw new Error('FATAL: Using default database password in production is not allowed');
    }
  }

  console.log('✓ Environment validation passed');
  console.log(`  - Helius key: ${heliusKey.substring(0, 8)}...${heliusKey.substring(heliusKey.length - 4)}`);
  console.log(`  - Admin key length: ${adminKey.length} characters`);
  console.log(`  - Environment: ${process.env.NODE_ENV || 'development'}`);
}

validateEnvironment();

const app = express();
const PORT = process.env.PORT || 3000;

// Security headers with Helmet
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },
  referrerPolicy: { policy: 'same-origin' },
}));

// CORS configuration - allow all origins for APIX marketplace
// APIX handles authentication/payment, so we allow all origins
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-api-key', 'Accept'],
  credentials: false,
  maxAge: 86400, // Cache preflight for 24h
}));

// HTTPS enforcement (production only)
function enforceHTTPS(req: express.Request, res: express.Response, next: express.NextFunction) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol;

  if (proto !== 'https' && process.env.NODE_ENV === 'production') {
    return res.status(403).json({
      error: 'HTTPS required',
      message: 'This API requires HTTPS in production',
    });
  }

  next();
}

if (process.env.NODE_ENV === 'production') {
  app.use(enforceHTTPS);
}

// Request body size limits (prevent DoS)
app.use(express.json({
  limit: '100kb',
  strict: true
}));

// Request ID middleware (for tracking and debugging)
app.use((req, res, next) => {
  const requestId = (req.headers['x-request-id'] as string) || uuidv4();
  req.requestId = requestId;
  res.setHeader('X-Request-ID', requestId);
  next();
});

// Content-Type validation for POST/PUT/PATCH requests
function validateContentType(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
    const contentType = req.headers['content-type'];

    if (!contentType || !contentType.includes('application/json')) {
      return res.status(415).json({
        error: 'Unsupported Media Type',
        message: 'Content-Type must be application/json',
        requestId: req.requestId,
      });
    }
  }

  next();
}

app.use(validateContentType);

app.use((req, res, next) => {
  res.setHeader('X-Powered-By', 'Token-Flow-API');
  next();
});

app.get('/health', async (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'token-flow-api',
  });
});

app.post(
  '/api/v1/analyze/path',
  authenticateApiKey,
  rateLimiter,
  validateSolanaAddress('address'),
  validateTokenMint('token'),
  validateMaxDepth,
  validateTimeRange,
  (req, res) => analysisController.analyzePath(req, res)
);

app.get(
  '/api/v1/risk/:address',
  authenticateApiKey,
  rateLimiter,
  validateSolanaAddress('address'),
  validateTokenMint('token'),
  (req, res) => analysisController.getRiskAssessment(req, res)
);

app.get(
  '/api/v1/intent/:signature',
  authenticateApiKey,
  rateLimiter,
  (req, res) => analysisController.getTransactionIntent(req, res)
);

app.post(
  '/api/v1/trace',
  authenticateApiKey,
  rateLimiter,
  validateSignatures,
  (req, res) => analysisController.traceTransactions(req, res)
);

app.post(
  '/api/v1/analyze/token',
  authenticateApiKey,
  rateLimiter,
  validateTokenMint('token'),
  (req, res) => analysisController.analyzeToken(req, res)
);

// ============================================================================
// USER MANAGEMENT ROUTES
// ============================================================================

// Public route: User registration (no auth required)
app.post(
  '/api/v1/users/register',
  (req, res) => userController.registerUser(req, res)
);

// Protected routes: Require API key authentication
app.get(
  '/api/v1/users/me',
  authenticateApiKey,
  (req, res) => userController.getCurrentUser(req, res)
);

app.get(
  '/api/v1/users/usage',
  authenticateApiKey,
  (req, res) => userController.getUserUsage(req, res)
);

app.get(
  '/api/v1/users/keys',
  authenticateApiKey,
  (req, res) => userController.getMyApiKeys(req, res)
);

app.post(
  '/api/v1/users/keys',
  authenticateApiKey,
  (req, res) => userController.generateNewApiKey(req, res)
);

app.delete(
  '/api/v1/users/keys/:keyId',
  authenticateApiKey,
  (req, res) => userController.deleteApiKey(req, res)
);

app.post(
  '/api/v1/users/plan',
  authenticateApiKey,
  (req, res) => userController.updatePlan(req, res)
);

app.post(
  '/api/v1/users/cancel',
  authenticateApiKey,
  (req, res) => userController.cancelSubscription(req, res)
);

// ============================================================================
// WEBHOOK ROUTES
// ============================================================================

// APIX Webhook Handler (no API key required, but should verify signature)
app.post(
  '/webhooks/apix',
  verifyWebhookSignature,
  (req, res) => handleApixWebhook(req, res)
);

// ============================================================================
// APIX PUBLIC ENDPOINTS (No API Key Required - Pay Per Call via APIX)
// ============================================================================

// Risk Assessment - Public for APIX users
app.get(
  '/apix/risk/:address',
  rateLimiter,
  validateSolanaAddress('address'),
  (req, res) => analysisController.getRiskAssessment(req, res)
);

// Entity Lookup - Public for APIX users
app.get(
  '/apix/entity/:address',
  rateLimiter,
  validateSolanaAddress('address'),
  async (req, res) => {
    const { address } = req.params;
    const entity = await entityService.getEntity(address);
    if (entity) {
      res.json({
        success: true,
        data: entity,
        timestamp: new Date().toISOString(),
      });
    } else {
      res.json({
        success: true,
        data: null,
        message: 'Address not found in entity database',
        timestamp: new Date().toISOString(),
      });
    }
  }
);

// Path Analysis - Public for APIX users (supports both GET and POST)
app.all(
  '/apix/analyze/path',
  rateLimiter,
  (req, res, next) => {
    // For GET requests, move query params to body
    if (req.method === 'GET') {
      req.body = { ...req.query };
    }
    next();
  },
  validateSolanaAddress('address'),
  validateTokenMint('token'),
  validateMaxDepth,
  validateTimeRange,
  (req, res) => analysisController.analyzePath(req, res)
);

// Token Analysis - Public for APIX users (supports both GET and POST)
app.all(
  '/apix/analyze/token',
  rateLimiter,
  (req, res, next) => {
    if (req.method === 'GET') {
      req.body = { ...req.query };
    }
    next();
  },
  validateTokenMint('token'),
  (req, res) => analysisController.analyzeToken(req, res)
);

// Transaction Intent - Public for APIX users
app.get(
  '/apix/intent/:signature',
  rateLimiter,
  (req, res) => analysisController.getTransactionIntent(req, res)
);

// Trace Transactions - Public for APIX users (supports both GET and POST)
app.all(
  '/apix/trace',
  rateLimiter,
  (req, res, next) => {
    if (req.method === 'GET') {
      req.body = { ...req.query };
      // Handle signatures as comma-separated string for GET
      if (typeof req.body.signatures === 'string') {
        req.body.signatures = req.body.signatures.split(',');
      }
    }
    next();
  },
  validateSignatures,
  (req, res) => analysisController.traceTransactions(req, res)
);

// ============================================================================
// APIX V2 ENDPOINTS (Exact paths matching APIX registration)
// ============================================================================

// Token Activity Analysis - APIX V2 compatible
// Maps all APIX param variations: tokenAddress/Token_Address/token_address -> token
app.all(
  '/api/token-flow-apiv2/token-activity-analysis',
  rateLimiter,
  (req, res, next) => {
    if (req.method === 'GET') {
      req.body = { ...req.query };
    }
    // Map all possible APIX parameter name variations to internal names
    // APIX may use: tokenAddress, Token_Address, token_address, TokenAddress, "Token Address"
    const tokenParam = req.body.tokenAddress || req.body.Token_Address ||
                       req.body.token_address || req.body.TokenAddress ||
                       req.body['Token Address'] || req.body.token;
    if (tokenParam) {
      req.body.token = tokenParam;
    }

    // Map txLimit variations: txLimit, Tx_Limit, tx_limit, TxLimit, "Tx Limit"
    const limitParam = req.body.txLimit || req.body.Tx_Limit ||
                       req.body.tx_limit || req.body.TxLimit ||
                       req.body['Tx Limit'] || req.body.limit;
    if (limitParam) {
      req.body.limit = parseInt(String(limitParam), 10);
    }
    next();
  },
  validateTokenMint('token'),
  (req, res) => analysisController.analyzeToken(req, res)
);

// Flow Path Analysis - APIX V2 compatible
// Maps all APIX param variations to internal names
app.all(
  '/api/token-flow-apiv2/flow-path-analysis',
  rateLimiter,
  (req, res, next) => {
    if (req.method === 'GET') {
      req.body = { ...req.query };
    }
    // Map all possible APIX parameter name variations to internal names
    // Address variations
    const addressParam = req.body.Address || req.body.address ||
                         req.body.wallet_address || req.body.walletAddress ||
                         req.body['Wallet Address'];
    if (addressParam) {
      req.body.address = addressParam;
    }

    // Token variations
    const tokenParam = req.body.Token || req.body.token ||
                       req.body.token_address || req.body.tokenAddress ||
                       req.body['Token Address'] || req.body.Token_Address;
    if (tokenParam) {
      req.body.token = tokenParam;
    }

    // Direction variations
    const directionParam = req.body.Direction || req.body.direction;
    if (directionParam) {
      req.body.direction = directionParam;
    }

    // maxDepth variations
    const depthParam = req.body.maxDepth || req.body.max_depth ||
                       req.body.Max_Depth || req.body['Max Depth'];
    if (depthParam) {
      req.body.maxDepth = parseInt(String(depthParam), 10);
    }

    // timeRange variations
    const timeParam = req.body.timeRange || req.body.time_range ||
                      req.body.Time_Range || req.body['Time Range'];
    if (timeParam) {
      req.body.timeRange = timeParam;
    }
    next();
  },
  validateSolanaAddress('address'),
  validateTokenMint('token'),
  validateMaxDepth,
  validateTimeRange,
  (req, res) => analysisController.analyzePath(req, res)
);

// ============================================================================
// APIX SLUG ENDPOINTS (Root level - matching APIX API slugs)
// APIX constructs URL as: {endpoint_url}/{api_slug}?params
// ============================================================================

// Token Activity Analysis - APIX slug endpoint
// APIX calls: /analyze-token-activity?token=...&limit=...
app.all(
  '/analyze-token-activity',
  rateLimiter,
  (req, res, next) => {
    if (req.method === 'GET') {
      req.body = { ...req.query };
    }
    // APIX sends 'token' and 'limit' directly (from registration config)
    next();
  },
  validateTokenMint('token'),
  (req, res) => analysisController.analyzeToken(req, res)
);

// Flow Path Analysis - APIX slug endpoint
// APIX calls: /flow-path-analysis?address=...&token=...
app.all(
  '/flow-path-analysis',
  rateLimiter,
  (req, res, next) => {
    if (req.method === 'GET') {
      req.body = { ...req.query };
    }
    next();
  },
  validateSolanaAddress('address'),
  validateTokenMint('token'),
  validateMaxDepth,
  validateTimeRange,
  (req, res) => analysisController.analyzePath(req, res)
);

// ============================================================================
// USAGE TRACKING & HEADERS
// ============================================================================

// Add usage tracking to all protected routes
// This should be applied AFTER authentication but BEFORE the route handler
// Note: We're applying it globally to all /api/v1/* routes
app.use('/api/v1/*', authenticateApiKey);
app.use('/api/v1/*', usageTrackingMiddleware);
app.use('/api/v1/*', addUsageHeaders);

// ============================================================================
// ERROR HANDLING
// ============================================================================

app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  // Log full error server-side only
  console.error('Unhandled error:', {
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    timestamp: new Date().toISOString(),
  });

  // Never send stack traces to client (even in dev mode)
  res.status(500).json({
    error: 'Internal server error',
    requestId: req.requestId,
    timestamp: new Date().toISOString(),
  });
});

async function initializeServices() {
  console.log('Loading entity database...');
  await entityService.loadEntityDatabase();

  console.log('Loading risk databases...');
  await riskScoringService.loadRiskDatabases();

  console.log('Services initialized');
}

async function startServer() {
  try {
    await initializeServices();

    app.listen(PORT, () => {
      console.log(`Token Flow API listening on port ${PORT}`);
      console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`Health check: http://localhost:${PORT}/health`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  startServer();
}

export { app };
