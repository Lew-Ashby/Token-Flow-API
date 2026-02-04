/**
 * Email and input validation utilities
 * RFC 5322 compliant email validation
 */

// RFC 5322 compliant email regex
// Source: https://emailregex.com/
const EMAIL_REGEX = /^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;

/**
 * Validate email address using RFC 5322 standard
 * @param email - Email address to validate
 * @returns true if valid, false otherwise
 */
export function isValidEmail(email: string): boolean {
  if (!email || typeof email !== 'string') {
    return false;
  }

  // Trim whitespace
  email = email.trim().toLowerCase();

  // Check length constraints
  if (email.length === 0 || email.length > 254) {
    return false;
  }

  // Test against RFC 5322 regex
  if (!EMAIL_REGEX.test(email)) {
    return false;
  }

  // Additional checks to prevent common bypasses
  const parts = email.split('@');
  if (parts.length !== 2) {
    return false;
  }

  const [localPart, domain] = parts;

  // Local part (before @) validation
  if (localPart.length === 0 || localPart.length > 64) {
    return false;
  }

  // Prevent consecutive dots
  if (localPart.includes('..') || domain.includes('..')) {
    return false;
  }

  // Domain validation
  if (domain.length === 0 || domain.length > 253) {
    return false;
  }

  // Prevent starting/ending with dot or dash
  if (domain.startsWith('.') || domain.endsWith('.') ||
      domain.startsWith('-') || domain.endsWith('-')) {
    return false;
  }

  // Check for valid TLD (at least 2 characters)
  const tld = domain.split('.').pop();
  if (!tld || tld.length < 2) {
    return false;
  }

  return true;
}

/**
 * Validate Solana address (base58, 32-44 characters)
 * @param address - Solana address to validate
 * @returns true if valid, false otherwise
 */
export function isValidSolanaAddress(address: string): boolean {
  if (!address || typeof address !== 'string') {
    return false;
  }

  // Solana addresses are base58 encoded, 32-44 characters
  const base58Regex = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  return base58Regex.test(address);
}

/**
 * Sanitize string input (prevent XSS)
 * @param input - String to sanitize
 * @returns Sanitized string
 */
export function sanitizeString(input: string): string {
  if (!input || typeof input !== 'string') {
    return '';
  }

  return input
    .trim()
    .replace(/[<>]/g, '') // Remove < and >
    .substring(0, 1000); // Limit length
}

/**
 * Validate API key format
 * @param apiKey - API key to validate
 * @returns true if valid format, false otherwise
 */
export function isValidApiKeyFormat(apiKey: string): boolean {
  if (!apiKey || typeof apiKey !== 'string') {
    return false;
  }

  // Format: tfa_live_<64_hex_chars>
  const apiKeyRegex = /^tfa_live_[a-f0-9]{64}$/;
  return apiKeyRegex.test(apiKey);
}
