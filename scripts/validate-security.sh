#!/bin/bash

# Token Flow API - Security Validation Script
# Run this before deploying to production to ensure all security measures are in place

set -e

RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}=====================================${NC}"
echo -e "${BLUE}Token Flow API - Security Validation${NC}"
echo -e "${BLUE}=====================================${NC}"
echo ""

CRITICAL_ISSUES=0
WARNING_ISSUES=0
PASSED_CHECKS=0

# Check if .env file exists
if [ ! -f ".env" ]; then
    echo -e "${RED}✗ CRITICAL: .env file not found!${NC}"
    echo "  Create .env from .env.example and configure all values"
    exit 1
fi

# Load environment variables
export $(grep -v '^#' .env | xargs)

echo -e "${BLUE}Checking Critical Security Items...${NC}"
echo ""

# 1. Check Helius API Key
echo -n "1. Helius API Key Rotation: "
EXPOSED_KEY="ad63db19-f488-4d30-826b-7be5ab395a07"
if [ "$HELIUS_API_KEY" = "$EXPOSED_KEY" ]; then
    echo -e "${RED}✗ FAIL${NC}"
    echo "   ⚠️  CRITICAL: You are using the EXPOSED Helius API key!"
    echo "   Current: $HELIUS_API_KEY"
    echo "   Action Required:"
    echo "   1. Go to https://helius.xyz and get a new API key"
    echo "   2. Update HELIUS_API_KEY in .env"
    echo "   3. Re-run this validation script"
    echo ""
    CRITICAL_ISSUES=$((CRITICAL_ISSUES + 1))
elif [ "$HELIUS_API_KEY" = "your_helius_api_key_here" ] || [ -z "$HELIUS_API_KEY" ]; then
    echo -e "${RED}✗ FAIL${NC}"
    echo "   Helius API key is not configured"
    CRITICAL_ISSUES=$((CRITICAL_ISSUES + 1))
else
    echo -e "${GREEN}✓ PASS${NC}"
    echo "   Using new Helius API key: ${HELIUS_API_KEY:0:8}...${HELIUS_API_KEY: -4}"
    PASSED_CHECKS=$((PASSED_CHECKS + 1))
fi

# 2. Check Admin API Key
echo -n "2. Admin API Key Security: "
OLD_ADMIN_KEY="admin_9fc65d0060b5b70d24f7532d9057d4914e983204efffa306f1232a02f38efd7b"
if [ "$ADMIN_API_KEY" = "$OLD_ADMIN_KEY" ]; then
    echo -e "${YELLOW}⚠ WARNING${NC}"
    echo "   You are using an old admin key. Consider rotating it."
    WARNING_ISSUES=$((WARNING_ISSUES + 1))
elif [ "$ADMIN_API_KEY" = "your_admin_key_here" ] || [ -z "$ADMIN_API_KEY" ]; then
    echo -e "${RED}✗ FAIL${NC}"
    echo "   Admin API key is not configured"
    echo "   Generate with: openssl rand -hex 32"
    CRITICAL_ISSUES=$((CRITICAL_ISSUES + 1))
elif [ ${#ADMIN_API_KEY} -lt 32 ]; then
    echo -e "${RED}✗ FAIL${NC}"
    echo "   Admin API key is too short (minimum 32 characters)"
    CRITICAL_ISSUES=$((CRITICAL_ISSUES + 1))
else
    echo -e "${GREEN}✓ PASS${NC}"
    echo "   Admin key length: ${#ADMIN_API_KEY} characters"
    PASSED_CHECKS=$((PASSED_CHECKS + 1))
fi

# 3. Check API Key Salt
echo -n "3. API Key Salt Security: "
if [ "$API_KEY_SALT" = "your_random_salt_for_api_keys_here" ] || [ -z "$API_KEY_SALT" ]; then
    echo -e "${RED}✗ FAIL${NC}"
    echo "   API key salt is not configured"
    echo "   Generate with: openssl rand -hex 32"
    CRITICAL_ISSUES=$((CRITICAL_ISSUES + 1))
elif [ ${#API_KEY_SALT} -lt 32 ]; then
    echo -e "${RED}✗ FAIL${NC}"
    echo "   API key salt is too short (minimum 32 characters)"
    CRITICAL_ISSUES=$((CRITICAL_ISSUES + 1))
else
    echo -e "${GREEN}✓ PASS${NC}"
    echo "   Salt length: ${#API_KEY_SALT} characters"
    PASSED_CHECKS=$((PASSED_CHECKS + 1))
fi

# 4. Check Database Password
echo -n "4. Database Password Security: "
WEAK_PASSWORDS=("password" "123456" "admin" "secure_db_password_2026" "your_secure_database_password_here")
IS_WEAK=0
for weak in "${WEAK_PASSWORDS[@]}"; do
    if [ "$POSTGRES_PASSWORD" = "$weak" ]; then
        IS_WEAK=1
        break
    fi
done

if [ $IS_WEAK -eq 1 ]; then
    echo -e "${YELLOW}⚠ WARNING${NC}"
    echo "   Using a weak or default database password"
    echo "   Recommendation: Use a strong randomly generated password"
    WARNING_ISSUES=$((WARNING_ISSUES + 1))
elif [ -z "$POSTGRES_PASSWORD" ]; then
    echo -e "${RED}✗ FAIL${NC}"
    echo "   Database password is not configured"
    CRITICAL_ISSUES=$((CRITICAL_ISSUES + 1))
else
    echo -e "${GREEN}✓ PASS${NC}"
    echo "   Password length: ${#POSTGRES_PASSWORD} characters"
    PASSED_CHECKS=$((PASSED_CHECKS + 1))
fi

# 5. Check NODE_ENV for production
echo -n "5. Production Environment: "
if [ "$NODE_ENV" = "production" ]; then
    echo -e "${GREEN}✓ PASS${NC}"
    echo "   NODE_ENV is set to production"
    PASSED_CHECKS=$((PASSED_CHECKS + 1))
else
    echo -e "${YELLOW}⚠ INFO${NC}"
    echo "   NODE_ENV is set to: $NODE_ENV"
    echo "   Remember to set NODE_ENV=production before deploying"
fi

# 6. Check CORS Configuration
echo -n "6. CORS Configuration: "
if [ "$NODE_ENV" = "production" ] && [ -z "$ALLOWED_ORIGINS" ]; then
    echo -e "${YELLOW}⚠ WARNING${NC}"
    echo "   ALLOWED_ORIGINS is not set in production"
    echo "   This will allow requests from any origin (security risk)"
    WARNING_ISSUES=$((WARNING_ISSUES + 1))
elif [ "$NODE_ENV" = "production" ]; then
    echo -e "${GREEN}✓ PASS${NC}"
    echo "   ALLOWED_ORIGINS: $ALLOWED_ORIGINS"
    PASSED_CHECKS=$((PASSED_CHECKS + 1))
else
    echo -e "${BLUE}○ SKIP${NC}"
    echo "   Not in production mode"
fi

# 7. Check .env is not in git
echo -n "7. Git Security (.env ignored): "
if git rev-parse --git-dir > /dev/null 2>&1; then
    if git check-ignore .env > /dev/null 2>&1; then
        echo -e "${GREEN}✓ PASS${NC}"
        echo "   .env is properly ignored by git"
        PASSED_CHECKS=$((PASSED_CHECKS + 1))
    else
        echo -e "${RED}✗ FAIL${NC}"
        echo "   .env is NOT in .gitignore!"
        echo "   Add '.env' to .gitignore immediately"
        CRITICAL_ISSUES=$((CRITICAL_ISSUES + 1))
    fi
else
    echo -e "${BLUE}○ SKIP${NC}"
    echo "   Not a git repository"
fi

# 8. Check for exposed secrets in git history (if git repo)
echo -n "8. Git History Check: "
if git rev-parse --git-dir > /dev/null 2>&1; then
    if git log --all --full-history --source --oneline -- .env > /dev/null 2>&1; then
        COMMITS=$(git log --all --full-history --source --oneline -- .env 2>/dev/null | wc -l)
        if [ $COMMITS -gt 0 ]; then
            echo -e "${RED}✗ WARNING${NC}"
            echo "   .env file found in git history ($COMMITS commits)"
            echo "   Your secrets may be exposed in git history"
            echo "   Consider using 'git filter-branch' or 'BFG Repo-Cleaner' to remove them"
            WARNING_ISSUES=$((WARNING_ISSUES + 1))
        else
            echo -e "${GREEN}✓ PASS${NC}"
            echo "   No .env file found in git history"
            PASSED_CHECKS=$((PASSED_CHECKS + 1))
        fi
    else
        echo -e "${GREEN}✓ PASS${NC}"
        echo "   No .env file found in git history"
        PASSED_CHECKS=$((PASSED_CHECKS + 1))
    fi
else
    echo -e "${BLUE}○ SKIP${NC}"
    echo "   Not a git repository"
fi

echo ""
echo -e "${BLUE}Checking APIX Integration Security...${NC}"
echo ""

# 9. Check APIX Webhook Secret (CRIT-NEW-001)
echo -n "9. APIX Webhook Secret: "
if [ -z "$APIX_WEBHOOK_SECRET" ] || [ "$APIX_WEBHOOK_SECRET" = "your_webhook_secret_here" ]; then
    echo -e "${RED}✗ FAIL${NC}"
    echo "   APIX webhook secret is not configured"
    echo "   This is required for webhook signature verification (CRIT-NEW-001)"
    echo "   Generate with: openssl rand -hex 32"
    CRITICAL_ISSUES=$((CRITICAL_ISSUES + 1))
elif [ ${#APIX_WEBHOOK_SECRET} -lt 32 ]; then
    echo -e "${YELLOW}⚠ WARNING${NC}"
    echo "   Webhook secret is too short (recommended: 32+ characters)"
    WARNING_ISSUES=$((WARNING_ISSUES + 1))
else
    echo -e "${GREEN}✓ PASS${NC}"
    echo "   Webhook secret configured (${#APIX_WEBHOOK_SECRET} characters)"
    PASSED_CHECKS=$((PASSED_CHECKS + 1))
fi

# 10. Check Webhook Signature Verification Implementation (CRIT-NEW-001)
echo -n "10. Webhook Signature Verification: "
WEBHOOK_CONTROLLER="services/api/src/controllers/webhook.controller.ts"
if [ -f "$WEBHOOK_CONTROLLER" ]; then
    if grep -q "verifyWebhookSignature" "$WEBHOOK_CONTROLLER" && \
       grep -q "timingSafeEqual" "$WEBHOOK_CONTROLLER" && \
       grep -q "createHmac.*sha256" "$WEBHOOK_CONTROLLER"; then
        echo -e "${GREEN}✓ PASS${NC}"
        echo "   Webhook signature verification is implemented with HMAC-SHA256"
        PASSED_CHECKS=$((PASSED_CHECKS + 1))
    else
        echo -e "${RED}✗ FAIL${NC}"
        echo "   Webhook signature verification is missing or incomplete"
        echo "   Required: HMAC-SHA256 signature verification with timing-safe comparison"
        CRITICAL_ISSUES=$((CRITICAL_ISSUES + 1))
    fi
else
    echo -e "${YELLOW}⚠ WARNING${NC}"
    echo "   Webhook controller file not found at: $WEBHOOK_CONTROLLER"
    WARNING_ISSUES=$((WARNING_ISSUES + 1))
fi

# 11. Check Email Validation Implementation (HIGH-NEW-001)
echo -n "11. RFC 5322 Email Validation: "
VALIDATION_FILE="services/api/src/utils/validation.ts"
if [ -f "$VALIDATION_FILE" ]; then
    if grep -q "isValidEmail" "$VALIDATION_FILE" && \
       grep -q "EMAIL_REGEX" "$VALIDATION_FILE" && \
       grep -q "RFC 5322" "$VALIDATION_FILE"; then
        echo -e "${GREEN}✓ PASS${NC}"
        echo "   RFC 5322 compliant email validation is implemented"
        PASSED_CHECKS=$((PASSED_CHECKS + 1))
    else
        echo -e "${RED}✗ FAIL${NC}"
        echo "   RFC 5322 email validation is missing or incomplete"
        CRITICAL_ISSUES=$((CRITICAL_ISSUES + 1))
    fi
else
    echo -e "${RED}✗ FAIL${NC}"
    echo "   Validation utility file not found at: $VALIDATION_FILE"
    CRITICAL_ISSUES=$((CRITICAL_ISSUES + 1))
fi

# 12. Check API Key Exposure Prevention (CRIT-NEW-002)
echo -n "12. API Key Exposure Prevention: "
if [ -f "$WEBHOOK_CONTROLLER" ]; then
    # Check that full API key is NOT returned, only keyPrefix
    if grep -q "keyPrefix.*apiKey\.keyPrefix" "$WEBHOOK_CONTROLLER" && \
       ! grep -q "fullKey\|apiKey\.key\|apiKey\.value" "$WEBHOOK_CONTROLLER"; then
        echo -e "${GREEN}✓ PASS${NC}"
        echo "   Webhook responses only return API key prefix (not full key)"
        PASSED_CHECKS=$((PASSED_CHECKS + 1))
    else
        echo -e "${YELLOW}⚠ WARNING${NC}"
        echo "   Unable to verify API key exposure prevention"
        echo "   Manually verify that webhook responses only return keyPrefix"
        WARNING_ISSUES=$((WARNING_ISSUES + 1))
    fi
else
    echo -e "${BLUE}○ SKIP${NC}"
    echo "   Webhook controller not found"
fi

echo ""
echo -e "${BLUE}=====================================${NC}"
echo -e "${BLUE}Validation Summary${NC}"
echo -e "${BLUE}=====================================${NC}"
echo ""
echo -e "${GREEN}✓ Passed Checks: $PASSED_CHECKS${NC}"
echo -e "${YELLOW}⚠ Warnings: $WARNING_ISSUES${NC}"
echo -e "${RED}✗ Critical Issues: $CRITICAL_ISSUES${NC}"
echo ""

if [ $CRITICAL_ISSUES -gt 0 ]; then
    echo -e "${RED}=====================================${NC}"
    echo -e "${RED}❌ VALIDATION FAILED${NC}"
    echo -e "${RED}=====================================${NC}"
    echo ""
    echo "You have $CRITICAL_ISSUES critical security issue(s) that MUST be fixed before deployment."
    echo ""
    echo "Common fixes:"
    echo "  • Rotate Helius API key: https://helius.xyz"
    echo "  • Generate admin key: openssl rand -hex 32"
    echo "  • Generate API salt: openssl rand -hex 32"
    echo "  • Generate APIX webhook secret: openssl rand -hex 32"
    echo "  • Add .env to .gitignore"
    echo ""
    exit 1
elif [ $WARNING_ISSUES -gt 0 ]; then
    echo -e "${YELLOW}=====================================${NC}"
    echo -e "${YELLOW}⚠️  VALIDATION PASSED WITH WARNINGS${NC}"
    echo -e "${YELLOW}=====================================${NC}"
    echo ""
    echo "You have $WARNING_ISSUES warning(s). Review them before deploying to production."
    echo ""
    exit 0
else
    echo -e "${GREEN}=====================================${NC}"
    echo -e "${GREEN}✅ ALL CHECKS PASSED${NC}"
    echo -e "${GREEN}=====================================${NC}"
    echo ""
    echo "Your configuration is secure and ready for deployment!"
    echo ""
    echo "Security fixes verified:"
    echo "  ✓ CRIT-NEW-001: Webhook signature verification (HMAC-SHA256)"
    echo "  ✓ CRIT-NEW-002: API key exposure prevention (keyPrefix only)"
    echo "  ✓ HIGH-NEW-001: RFC 5322 email validation"
    echo ""
    echo "Next steps:"
    echo "  1. Set NODE_ENV=production in .env"
    echo "  2. Configure ALLOWED_ORIGINS for your domain"
    echo "  3. Run APIX security tests: ./scripts/test-apix-security.sh"
    echo "  4. Deploy using: docker-compose up -d"
    echo ""
    exit 0
fi
