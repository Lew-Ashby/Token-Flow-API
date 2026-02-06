import { Request, Response, NextFunction } from 'express';
import { PublicKey } from '@solana/web3.js';

export function validateSolanaAddress(addressParam: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const address = req.params[addressParam] || req.body[addressParam] || req.query[addressParam];

    if (!address) {
      res.status(400).json({
        error: `Missing required parameter: ${addressParam}`,
      });
      return;
    }

    try {
      new PublicKey(address);
      next();
    } catch (error) {
      res.status(400).json({
        error: `Invalid Solana address: ${address}`,
        message: 'Address must be a valid base58 public key',
      });
    }
  };
}

export function validateTokenMint(mintParam: string = 'token') {
  return (req: Request, res: Response, next: NextFunction): void => {
    const mint = req.body[mintParam] || req.query[mintParam];

    if (!mint) {
      res.status(400).json({
        error: `Missing required parameter: ${mintParam}`,
      });
      return;
    }

    try {
      new PublicKey(mint);
      next();
    } catch (error) {
      res.status(400).json({
        error: `Invalid token mint address: ${mint}`,
      });
    }
  };
}

export function validateMaxDepth(req: Request, res: Response, next: NextFunction): void {
  const maxDepth = req.body.maxDepth;

  if (maxDepth !== undefined) {
    const depth = parseInt(maxDepth);

    if (isNaN(depth) || depth < 1 || depth > 10) {
      res.status(400).json({
        error: 'Invalid maxDepth',
        message: 'maxDepth must be between 1 and 10',
      });
      return;
    }

    req.body.maxDepth = depth;
  }

  next();
}

export function validateTimeRange(req: Request, res: Response, next: NextFunction): void {
  const timeRange = req.body.timeRange;

  if (timeRange) {
    const pattern = /^(\d+)([dhm])$/;
    const match = timeRange.match(pattern);

    if (!match) {
      res.status(400).json({
        error: 'Invalid timeRange format',
        message: 'timeRange must be in format: <number><unit> (e.g., 30d, 24h, 60m)',
      });
      return;
    }

    const value = parseInt(match[1]);
    const unit = match[2];

    // Enforce maximum time ranges to prevent excessive queries
    const limits = {
      m: 1440,   // Max 1440 minutes (24 hours)
      h: 720,    // Max 720 hours (30 days)
      d: 365,    // Max 365 days (1 year)
    };

    if (value > limits[unit as keyof typeof limits]) {
      res.status(400).json({
        error: 'Time range too large',
        message: `Maximum time range: 365d, 720h, or 1440m`,
        requested: timeRange,
      });
      return;
    }
  }

  next();
}

export function validateSignatures(req: Request, res: Response, next: NextFunction): void {
  const signatures = req.body.signatures;
  const BASE58_REGEX = /^[1-9A-HJ-NP-Za-km-z]{87,88}$/;

  if (!Array.isArray(signatures)) {
    res.status(400).json({
      error: 'signatures must be an array',
    });
    return;
  }

  if (signatures.length === 0) {
    res.status(400).json({
      error: 'signatures array cannot be empty',
    });
    return;
  }

  if (signatures.length > 100) {
    res.status(400).json({
      error: 'Too many signatures',
      message: 'Maximum 100 signatures per request',
    });
    return;
  }

  for (const sig of signatures) {
    if (typeof sig !== 'string' || !BASE58_REGEX.test(sig)) {
      res.status(400).json({
        error: 'Invalid signature format',
        message: 'Signatures must be 87-88 character base58 strings (no 0, O, I, l)',
      });
      return;
    }
  }

  next();
}
