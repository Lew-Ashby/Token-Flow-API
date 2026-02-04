#!/bin/bash

# Test script for APIX Integration Security Fixes
# Tests all 3 critical security issues identified in audit

set -e

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

API_URL="${API_URL:-http://localhost:3000}"
WEBHOOK_SECRET="${APIX_WEBHOOK_SECRET:-test_webhook_secret}"

echo "=========================================="
echo "APIX Security Fixes Test Suite"
echo "=========================================="
echo "API URL: $API_URL"
echo ""

# Test counter
PASS=0
FAIL=0

#==========================================
# Helper Functions
#==========================================

function test_passed() {
    echo -e "${GREEN}✓ PASS${NC}: $1"
    ((PASS++))
}

function test_failed() {
    echo -e "${RED}✗ FAIL${NC}: $1"
    ((FAIL++))
}

function generate_signature() {
    local payload="$1"
    echo -n "$payload" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | awk '{print $2}'
}

#==========================================
# Test 1: Webhook Signature Verification
#==========================================

echo -e "${YELLOW}Test 1: Webhook Signature Verification (CRIT-NEW-001)${NC}"
echo "----------------------------------------------"

# Test 1.1: Missing signature should be rejected
echo "Test 1.1: Reject webhook without signature..."
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$API_URL/webhooks/apix" \
  -H "Content-Type: application/json" \
  -d '{
    "event": "user.subscribed",
    "data": {
      "apixUserId": "test_user_1",
      "email": "test@example.com"
    },
    "timestamp": "2026-02-04T10:00:00Z"
  }')

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" == "401" ] && echo "$BODY" | grep -q "signature"; then
    test_passed "Webhook without signature rejected (401)"
else
    test_failed "Webhook without signature NOT rejected (got $HTTP_CODE)"
fi

# Test 1.2: Invalid signature should be rejected
echo "Test 1.2: Reject webhook with invalid signature..."
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$API_URL/webhooks/apix" \
  -H "Content-Type: application/json" \
  -H "x-webhook-signature: invalid_signature_12345" \
  -d '{
    "event": "user.subscribed",
    "data": {
      "apixUserId": "test_user_2",
      "email": "test@example.com"
    },
    "timestamp": "2026-02-04T10:00:00Z"
  }')

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" == "401" ] && echo "$BODY" | grep -q "Invalid"; then
    test_passed "Webhook with invalid signature rejected (401)"
else
    test_failed "Webhook with invalid signature NOT rejected (got $HTTP_CODE)"
fi

# Test 1.3: Valid signature should be accepted
echo "Test 1.3: Accept webhook with valid signature..."
PAYLOAD='{"event":"user.subscribed","data":{"apixUserId":"test_user_3","email":"valid@example.com"},"timestamp":"2026-02-04T10:00:00Z"}'
SIGNATURE=$(generate_signature "$PAYLOAD")

RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$API_URL/webhooks/apix" \
  -H "Content-Type: application/json" \
  -H "x-webhook-signature: $SIGNATURE" \
  -d "$PAYLOAD")

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" == "201" ] || [ "$HTTP_CODE" == "200" ]; then
    test_passed "Webhook with valid signature accepted ($HTTP_CODE)"
else
    test_failed "Webhook with valid signature rejected (got $HTTP_CODE)"
fi

echo ""

#==========================================
# Test 2: API Key Exposure
#==========================================

echo -e "${YELLOW}Test 2: API Key Exposure Prevention (CRIT-NEW-002)${NC}"
echo "----------------------------------------------"

# Test 2.1: Check that full API key is NOT in webhook response
echo "Test 2.1: Full API key should not be exposed in webhook response..."
PAYLOAD='{"event":"user.subscribed","data":{"apixUserId":"test_user_key","email":"keytest@example.com"},"timestamp":"2026-02-04T10:00:00Z"}'
SIGNATURE=$(generate_signature "$PAYLOAD")

RESPONSE=$(curl -s -X POST "$API_URL/webhooks/apix" \
  -H "Content-Type: application/json" \
  -H "x-webhook-signature: $SIGNATURE" \
  -d "$PAYLOAD")

# Check if response contains full API key (tfa_live_<64 hex chars>)
if echo "$RESPONSE" | grep -qE "tfa_live_[a-f0-9]{64}"; then
    test_failed "Full API key exposed in webhook response!"
    echo "Response: $RESPONSE"
else
    test_passed "Full API key NOT exposed in webhook response"
fi

# Test 2.2: Check that only key prefix is returned
echo "Test 2.2: Only key prefix should be in response..."
if echo "$RESPONSE" | grep -q "keyPrefix"; then
    test_passed "Key prefix found in response (secure)"
else
    test_failed "Key prefix not found in response"
fi

echo ""

#==========================================
# Test 3: Email Validation
#==========================================

echo -e "${YELLOW}Test 3: RFC 5322 Email Validation (HIGH-NEW-001)${NC}"
echo "----------------------------------------------"

# Test 3.1: Invalid email - double @ should be rejected
echo "Test 3.1: Reject invalid email (double @)..."
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$API_URL/api/v1/users/register" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@@example.com",
    "fullName": "Test User"
  }')

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" == "400" ] && echo "$BODY" | grep -q "Invalid"; then
    test_passed "Invalid email (double @) rejected (400)"
else
    test_failed "Invalid email (double @) NOT rejected (got $HTTP_CODE)"
fi

# Test 3.2: Invalid email - no domain should be rejected
echo "Test 3.2: Reject invalid email (no domain)..."
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$API_URL/api/v1/users/register" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@",
    "fullName": "Test User"
  }')

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" == "400" ]; then
    test_passed "Invalid email (no domain) rejected (400)"
else
    test_failed "Invalid email (no domain) NOT rejected (got $HTTP_CODE)"
fi

# Test 3.3: Invalid email - missing @ should be rejected
echo "Test 3.3: Reject invalid email (missing @)..."
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$API_URL/api/v1/users/register" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "testexample.com",
    "fullName": "Test User"
  }')

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" == "400" ]; then
    test_passed "Invalid email (missing @) rejected (400)"
else
    test_failed "Invalid email (missing @) NOT rejected (got $HTTP_CODE)"
fi

# Test 3.4: Valid email should be accepted
echo "Test 3.4: Accept valid email..."
VALID_EMAIL="valid.test+tag@example.co.uk"
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$API_URL/api/v1/users/register" \
  -H "Content-Type: application/json" \
  -d "{
    \"email\": \"$VALID_EMAIL\",
    \"fullName\": \"Test User\"
  }")

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" == "201" ] || [ "$HTTP_CODE" == "409" ]; then
    test_passed "Valid email accepted (${HTTP_CODE})"
else
    test_failed "Valid email rejected (got $HTTP_CODE)"
    echo "Response: $BODY"
fi

# Test 3.5: Email validation in webhook
echo "Test 3.5: Email validation in webhook handler..."
PAYLOAD='{"event":"user.subscribed","data":{"apixUserId":"test_invalid_email","email":"invalid@@email.com"},"timestamp":"2026-02-04T10:00:00Z"}'
SIGNATURE=$(generate_signature "$PAYLOAD")

RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$API_URL/webhooks/apix" \
  -H "Content-Type: application/json" \
  -H "x-webhook-signature: $SIGNATURE" \
  -d "$PAYLOAD")

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" == "400" ] && echo "$BODY" | grep -q "Invalid"; then
    test_passed "Invalid email in webhook rejected (400)"
else
    test_failed "Invalid email in webhook NOT rejected (got $HTTP_CODE)"
fi

echo ""

#==========================================
# Summary
#==========================================

TOTAL=$((PASS + FAIL))
echo "=========================================="
echo "Test Results Summary"
echo "=========================================="
echo -e "Total Tests: $TOTAL"
echo -e "${GREEN}Passed: $PASS${NC}"
echo -e "${RED}Failed: $FAIL${NC}"
echo ""

if [ $FAIL -eq 0 ]; then
    echo -e "${GREEN}✅ ALL TESTS PASSED!${NC}"
    echo "All critical security fixes verified ✓"
    exit 0
else
    echo -e "${RED}❌ SOME TESTS FAILED${NC}"
    echo "Please review the failed tests above"
    exit 1
fi
