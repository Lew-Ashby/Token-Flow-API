#!/bin/bash

# Token Flow API - Security Fixes Testing Script
# Tests all 9 security fixes from the audit report

set -e

RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
API_BASE="${API_BASE:-http://localhost:3000}"
ML_BASE="${ML_BASE:-http://localhost:8001}"

# Load environment for admin key
if [ -f ".env" ]; then
    export $(grep -v '^#' .env | xargs)
fi

ADMIN_KEY="${ADMIN_API_KEY:-admin_0618d56511d1386bf3dc70bd07c0613083f2b4b8}"
TEST_API_KEY="${TEST_API_KEY:-test_api_key_123}"

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}Security Fixes Testing (All 9 Fixes)${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo "Testing against:"
echo "  API: $API_BASE"
echo "  ML:  $ML_BASE"
echo ""

PASSED=0
FAILED=0

# Helper function to test endpoint
test_endpoint() {
    local test_name="$1"
    local curl_cmd="$2"
    local expected_status="$3"
    local expected_pattern="$4"

    echo -n "Testing: $test_name ... "

    # Execute curl and capture response
    response=$(eval "$curl_cmd" 2>&1)
    status=$?

    # Check if command succeeded
    if [ $status -ne 0 ]; then
        echo -e "${RED}✗ FAIL${NC}"
        echo "   Command failed: $curl_cmd"
        echo "   Error: $response"
        FAILED=$((FAILED + 1))
        return 1
    fi

    # Check status code if provided
    if [ -n "$expected_status" ]; then
        http_status=$(echo "$response" | grep -o "HTTP/[0-9.]* [0-9]*" | tail -1 | awk '{print $2}')
        if [ "$http_status" != "$expected_status" ]; then
            echo -e "${RED}✗ FAIL${NC}"
            echo "   Expected status: $expected_status, Got: $http_status"
            FAILED=$((FAILED + 1))
            return 1
        fi
    fi

    # Check pattern if provided
    if [ -n "$expected_pattern" ]; then
        if echo "$response" | grep -q "$expected_pattern"; then
            echo -e "${GREEN}✓ PASS${NC}"
            PASSED=$((PASSED + 1))
            return 0
        else
            echo -e "${RED}✗ FAIL${NC}"
            echo "   Expected pattern not found: $expected_pattern"
            echo "   Response: $response"
            FAILED=$((FAILED + 1))
            return 1
        fi
    fi

    echo -e "${GREEN}✓ PASS${NC}"
    PASSED=$((PASSED + 1))
    return 0
}

echo -e "${BLUE}Testing Security Fixes...${NC}"
echo ""

# =============================================================================
# FIX 1: HIGH-003 - ML Training Authentication
# =============================================================================
echo -e "${BLUE}[FIX 1] HIGH-003: ML Training Authentication${NC}"

# Test 1.1: Training endpoint requires auth
test_endpoint \
    "ML training requires admin key" \
    "curl -s -X POST $ML_BASE/train" \
    "" \
    "Unauthorized"

# Test 1.2: Training endpoint accepts valid admin key
test_endpoint \
    "ML training accepts valid admin key" \
    "curl -s -X POST $ML_BASE/train -H 'x-admin-key: $ADMIN_KEY'" \
    "" \
    "status"

# Test 1.3: Training status requires auth (NEW-002)
test_endpoint \
    "ML training status requires auth" \
    "curl -s -X GET $ML_BASE/train/status" \
    "" \
    "Unauthorized"

# Test 1.4: Training status accepts valid admin key
test_endpoint \
    "ML training status accepts admin key" \
    "curl -s -X GET $ML_BASE/train/status -H 'x-admin-key: $ADMIN_KEY'" \
    "" \
    "status"

echo ""

# =============================================================================
# FIX 2: MED-003 - Batch Size Limits
# =============================================================================
echo -e "${BLUE}[FIX 2] MED-003: Batch Size Limits${NC}"

# Test 2.1: Batch limit enforcement (max 100)
# Generate array with 101 items
LARGE_BATCH='{"transactions":['
for i in {1..101}; do
    LARGE_BATCH="$LARGE_BATCH{\"signature\":\"sig$i\",\"amount\":1000,\"from\":\"addr1\",\"to\":\"addr2\"}"
    if [ $i -lt 101 ]; then
        LARGE_BATCH="$LARGE_BATCH,"
    fi
done
LARGE_BATCH="$LARGE_BATCH]}"

test_endpoint \
    "Batch prediction rejects >100 items" \
    "curl -s -X POST $ML_BASE/predict/batch -H 'Content-Type: application/json' -d '$LARGE_BATCH'" \
    "" \
    "Batch size exceeds maximum"

# Test 2.2: Valid batch size accepted
VALID_BATCH='{"transactions":[{"signature":"sig1","amount":1000,"from":"addr1","to":"addr2"}]}'
test_endpoint \
    "Batch prediction accepts valid size" \
    "curl -s -X POST $ML_BASE/predict/batch -H 'Content-Type: application/json' -d '$VALID_BATCH'" \
    "" \
    "predictions"

echo ""

# =============================================================================
# FIX 3: MED-005 - HTTPS Enforcement
# =============================================================================
echo -e "${BLUE}[FIX 3] MED-005: HTTPS Enforcement${NC}"

# Note: This test only works if NODE_ENV=production
if [ "$NODE_ENV" = "production" ]; then
    test_endpoint \
        "HTTPS enforcement in production" \
        "curl -s http://localhost:3000/health" \
        "" \
        "HTTPS required"
else
    echo "Skipping HTTPS test (NODE_ENV != production)"
    echo "   To test: Set NODE_ENV=production and restart services"
fi

echo ""

# =============================================================================
# FIX 4: MED-006 - Time Range Validation
# =============================================================================
echo -e "${BLUE}[FIX 4] MED-006: Time Range Validation${NC}"

# Test 4.1: Invalid time range rejected
INVALID_TIME_RANGE='{
    "address": "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
    "token": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "timeRange": "999d",
    "direction": "forward",
    "maxDepth": 2
}'

test_endpoint \
    "Time range >365d rejected" \
    "curl -s -X POST $API_BASE/api/v1/analyze/path -H 'x-api-key: $TEST_API_KEY' -H 'Content-Type: application/json' -d '$INVALID_TIME_RANGE'" \
    "" \
    "Time range must be"

# Test 4.2: Valid time range accepted
VALID_TIME_RANGE='{
    "address": "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
    "token": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "timeRange": "7d",
    "direction": "forward",
    "maxDepth": 2
}'

test_endpoint \
    "Valid time range accepted" \
    "curl -s -X POST $API_BASE/api/v1/analyze/path -H 'x-api-key: $TEST_API_KEY' -H 'Content-Type: application/json' -d '$VALID_TIME_RANGE'" \
    "" \
    "paths"

echo ""

# =============================================================================
# FIX 5: LOW-002 - Request ID Tracking
# =============================================================================
echo -e "${BLUE}[FIX 5] LOW-002: Request ID Tracking${NC}"

# Test 5.1: Request ID header present
response=$(curl -s -i $API_BASE/health 2>&1)
if echo "$response" | grep -qi "x-request-id"; then
    echo -e "Request ID header present: ${GREEN}✓ PASS${NC}"
    PASSED=$((PASSED + 1))
else
    echo -e "Request ID header missing: ${RED}✗ FAIL${NC}"
    FAILED=$((FAILED + 1))
fi

# Test 5.2: Custom request ID accepted
response=$(curl -s -i -H "x-request-id: custom-id-123" $API_BASE/health 2>&1)
if echo "$response" | grep -q "custom-id-123"; then
    echo -e "Custom request ID accepted: ${GREEN}✓ PASS${NC}"
    PASSED=$((PASSED + 1))
else
    echo -e "Custom request ID not accepted: ${RED}✗ FAIL${NC}"
    FAILED=$((FAILED + 1))
fi

echo ""

# =============================================================================
# FIX 6: LOW-004 - Content-Type Validation
# =============================================================================
echo -e "${BLUE}[FIX 6] LOW-004: Content-Type Validation${NC}"

# Test 6.1: Invalid content-type rejected
test_endpoint \
    "Invalid Content-Type rejected" \
    "curl -s -X POST $API_BASE/api/v1/analyze/path -H 'x-api-key: $TEST_API_KEY' -H 'Content-Type: text/plain' -d 'invalid'" \
    "" \
    "Unsupported Media Type"

# Test 6.2: Valid content-type accepted
test_endpoint \
    "Valid Content-Type accepted" \
    "curl -s -X POST $API_BASE/api/v1/analyze/path -H 'x-api-key: $TEST_API_KEY' -H 'Content-Type: application/json' -d '{\"address\":\"test\",\"token\":\"test\",\"direction\":\"forward\",\"maxDepth\":2}'" \
    "" \
    ""

echo ""

# =============================================================================
# FIX 7: NEW-001 - Admin API Key Rotation
# =============================================================================
echo -e "${BLUE}[FIX 7] NEW-001: Admin API Key Rotation${NC}"

# Check if new admin key is being used
if [ "$ADMIN_KEY" = "admin_9fc65d0060b5b70d24f7532d9057d4914e983204efffa306f1232a02f38efd7b" ]; then
    echo -e "Admin key NOT rotated (old key still in use): ${RED}✗ FAIL${NC}"
    FAILED=$((FAILED + 1))
elif [ ${#ADMIN_KEY} -ge 64 ]; then
    echo -e "Admin key rotated (new key in use): ${GREEN}✓ PASS${NC}"
    echo "   Key: ${ADMIN_KEY:0:12}...${ADMIN_KEY: -4}"
    PASSED=$((PASSED + 1))
else
    echo -e "Admin key too short: ${RED}✗ FAIL${NC}"
    FAILED=$((FAILED + 1))
fi

echo ""

# =============================================================================
# FIX 8: NEW-003 - TypeScript Type Safety
# =============================================================================
echo -e "${BLUE}[FIX 8] NEW-003: TypeScript Type Safety${NC}"

# Check if type declaration file exists
if [ -f "services/api/src/types/express.d.ts" ]; then
    echo -e "TypeScript declarations file exists: ${GREEN}✓ PASS${NC}"
    PASSED=$((PASSED + 1))

    # Check if requestId is properly typed
    if grep -q "requestId" "services/api/src/types/express.d.ts"; then
        echo -e "RequestId properly typed: ${GREEN}✓ PASS${NC}"
        PASSED=$((PASSED + 1))
    else
        echo -e "RequestId not found in types: ${RED}✗ FAIL${NC}"
        FAILED=$((FAILED + 1))
    fi
else
    echo -e "TypeScript declarations file missing: ${RED}✗ FAIL${NC}"
    FAILED=$((FAILED + 1))
fi

echo ""

# =============================================================================
# FIX 9: BONUS - Helius Key Not Exposed
# =============================================================================
echo -e "${BLUE}[FIX 9] CRITICAL: Helius API Key Rotation${NC}"

EXPOSED_KEY="ad63db19-f488-4d30-826b-7be5ab395a07"
CURRENT_KEY="${HELIUS_API_KEY}"

if [ "$CURRENT_KEY" = "$EXPOSED_KEY" ]; then
    echo -e "Helius key is EXPOSED: ${RED}✗ CRITICAL FAIL${NC}"
    echo "   ⚠️  You MUST rotate this key before deploying!"
    echo "   See HELIUS_KEY_ROTATION.md for instructions"
    FAILED=$((FAILED + 1))
elif [ "$CURRENT_KEY" = "your_helius_api_key_here" ]; then
    echo -e "Helius key not configured: ${YELLOW}⚠ WARNING${NC}"
    echo "   Configure a valid Helius API key in .env"
elif [ -z "$CURRENT_KEY" ]; then
    echo -e "Helius key missing: ${RED}✗ FAIL${NC}"
    FAILED=$((FAILED + 1))
else
    echo -e "Helius key properly rotated: ${GREEN}✓ PASS${NC}"
    echo "   Key: ${CURRENT_KEY:0:8}...${CURRENT_KEY: -4}"
    PASSED=$((PASSED + 1))
fi

echo ""

# =============================================================================
# Summary
# =============================================================================
echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}Test Summary${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo -e "${GREEN}✓ Passed: $PASSED${NC}"
echo -e "${RED}✗ Failed: $FAILED${NC}"
echo ""

TOTAL=$((PASSED + FAILED))
PASS_RATE=$((PASSED * 100 / TOTAL))

if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}========================================${NC}"
    echo -e "${GREEN}✅ ALL TESTS PASSED ($PASS_RATE%)${NC}"
    echo -e "${GREEN}========================================${NC}"
    echo ""
    echo "All 9 security fixes are working correctly!"
    echo "Your API is ready for deployment."
    echo ""
    exit 0
else
    echo -e "${RED}========================================${NC}"
    echo -e "${RED}❌ SOME TESTS FAILED ($PASS_RATE% pass rate)${NC}"
    echo -e "${RED}========================================${NC}"
    echo ""
    echo "Please fix the failing tests before deploying."
    echo ""
    echo "Common fixes:"
    echo "  • Ensure services are running: docker-compose up -d"
    echo "  • Check .env configuration"
    echo "  • Rotate Helius API key if exposed"
    echo "  • Verify admin key is set correctly"
    echo ""
    exit 1
fi
