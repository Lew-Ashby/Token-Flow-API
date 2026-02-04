# Token Flow API - Testing Guide

## ✅ Your API is Ready!

**API URL:** http://localhost:3000
**ML Service Docs:** http://localhost:8001/docs
**Your Test API Key:** `test_api_key_123`

---

## Quick Test Commands

### 1. Health Check (No Auth Required)
```bash
curl http://localhost:3000/health
```

### 2. Risk Assessment
```bash
curl -H 'x-api-key: test_api_key_123' \
  'http://localhost:3000/api/v1/risk/JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4?token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
```

**Response:**
```json
{
  "address": "JUP6...",
  "riskScore": 0,
  "riskLevel": "low",
  "flags": []
}
```

### 3. Flow Path Analysis
```bash
curl -H 'x-api-key: test_api_key_123' \
  -H 'Content-Type: application/json' \
  -X POST http://localhost:3000/api/v1/analyze/path \
  -d '{
    "address": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
    "token": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "direction": "forward",
    "maxDepth": 3,
    "timeRange": "7d"
  }'
```

### 4. Transaction Intent Classification
```bash
# You need a real Solana transaction signature
curl -H 'x-api-key: test_api_key_123' \
  'http://localhost:3000/api/v1/intent/<transaction_signature>'
```

### 5. Multi-Transaction Trace
```bash
curl -H 'x-api-key: test_api_key_123' \
  -H 'Content-Type: application/json' \
  -X POST http://localhost:3000/api/v1/trace \
  -d '{
    "signatures": ["sig1", "sig2"],
    "buildGraph": true
  }'
```

---

## Test Addresses

### Known Solana Addresses (Safe to Test):

**Jupiter Aggregator (DEX Aggregator):**
- Address: `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4`
- Expected Risk: Low

**Raydium (DEX):**
- Address: `675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8`
- Expected Risk: Low

**USDC Token Mint:**
- Address: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`

### Finding Real Transaction Signatures:

1. Go to https://solscan.io
2. Search for any address
3. Click on a transaction
4. Copy the signature (long alphanumeric string at the top)

---

## API Response Examples

### Risk Assessment Response:
```json
{
  "address": "7xKXtg...",
  "riskScore": 15,
  "riskLevel": "low",
  "flags": [],
  "lastAssessed": "2026-02-02T22:29:00.268Z"
}
```

### Flow Path Response:
```json
{
  "paths": [
    {
      "pathId": "uuid",
      "startAddress": "addr1",
      "endAddress": "addr3",
      "hops": [
        {
          "address": "addr1",
          "entityType": "wallet",
          "amountIn": "1000000000",
          "amountOut": "1000000000"
        },
        {
          "address": "addr2",
          "entityType": "dex",
          "entityName": "Raydium",
          "amountIn": "1000000000",
          "amountOut": "995000000"
        }
      ],
      "totalAmount": "1000000000",
      "hopCount": 2,
      "confidenceScore": 0.92,
      "intent": "trading",
      "riskScore": 10,
      "riskLevel": "low"
    }
  ],
  "summary": {
    "totalPaths": 1,
    "netFlow": {
      "in": "2000000000",
      "out": "1000000000"
    }
  }
}
```

---

## Troubleshooting

### "Invalid API key" Error:
Your API key is: `test_api_key_123`
Make sure to include it in the header: `-H 'x-api-key: test_api_key_123'`

### "Rate limit exceeded":
The test key allows 100 requests/minute. Wait a minute and try again.

### No paths found:
- Try different addresses (some addresses might not have recent transfers)
- Increase the time range (e.g., "30d" instead of "7d")
- Try backward direction to see where funds came from

### Transaction signature not found:
- Make sure the signature is valid and recent
- Use signatures from https://solscan.io

---

## Services Status

Check all services are running:
```bash
docker ps --filter "name=token-flow-api"
```

Should show:
- ✅ token-flow-api-api-1 (port 3000)
- ✅ token-flow-api-ml-inference-1 (port 8001)
- ✅ token-flow-api-postgres-1 (port 5432)
- ✅ token-flow-api-redis-1 (port 6379)

---

## Useful Commands

**Restart API:**
```bash
docker restart token-flow-api-api-1
```

**View API logs:**
```bash
docker logs -f token-flow-api-api-1
```

**View ML service logs:**
```bash
docker logs -f token-flow-api-ml-inference-1
```

**Stop all services:**
```bash
docker compose down
```

**Start all services:**
```bash
docker compose up -d
```

---

## Next Steps

1. **Test with real addresses** from Solscan
2. **Try different time ranges** (1d, 7d, 30d)
3. **Experiment with maxDepth** (1-5 hops)
4. **Check the ML service docs** at http://localhost:8001/docs
5. **Consider building a web UI** for easier testing

---

**Your API Key:** `test_api_key_123`
**Keep this key secret in production!**
