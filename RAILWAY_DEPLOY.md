# Railway Deployment Guide

## Prerequisites
- GitHub repository with your API code
- Railway account (https://railway.app)
- Helius API key (https://helius.xyz)

## Step 1: Push Code to GitHub

If you haven't already pushed your code to GitHub, run:

```bash
chmod +x setup-github.sh
./setup-github.sh
```

## Step 2: Create New Railway Project

1. Go to https://railway.app/new
2. Click **"Deploy from GitHub repo"**
3. Select your repository
4. Railway will auto-detect the build configuration from `railway.json`

## Step 3: Add PostgreSQL Database

1. In your Railway project dashboard, click **"+ New"**
2. Select **"Database"** → **"PostgreSQL"**
3. Railway will automatically create the database and set these environment variables:
   - `DATABASE_URL`
   - `PGHOST`
   - `PGPORT`
   - `PGDATABASE`
   - `PGUSER`
   - `PGPASSWORD`

## Step 4: Configure Environment Variables

⚠️ **CRITICAL**: You must manually set these environment variables in Railway:

Go to your service → **Variables** tab and add:

### Required Variables

```bash
# Helius API Configuration (REQUIRED)
HELIUS_API_KEY=d37de030-700b-40cd-9c5f-d77c83860e5f
HELIUS_CLUSTER=mainnet-beta

# Database Configuration (use Railway's PostgreSQL variables)
POSTGRES_HOST=${{Postgres.PGHOST}}
POSTGRES_PORT=${{Postgres.PGPORT}}
POSTGRES_DB=${{Postgres.PGDATABASE}}
POSTGRES_USER=${{Postgres.PGUSER}}
POSTGRES_PASSWORD=${{Postgres.PGPASSWORD}}

# API Security (REQUIRED)
ADMIN_API_KEY=admin_0618d56511d1386bf3dc70bd07c0613083f2b4b8
API_KEY_SALT=9fc65d0060b5b70d24f7532d9057d4914e983204efffa306f1232a02f38efd7b

# APIX Integration (CRITICAL - Required for webhook security)
APIX_WEBHOOK_SECRET=52a6cf98a4b15a2a5cf8464219af61409cab93e9eee50abc7b3588fd44277f87

# Production Configuration
NODE_ENV=production
PORT=3000

# CORS - Update with your Railway domain after first deployment
ALLOWED_ORIGINS=https://your-app-name.up.railway.app,https://apix.com
```

### Optional Variables (if using Redis/ML services)

```bash
# Redis (if you add Redis database)
REDIS_HOST=${{Redis.REDIS_HOST}}
REDIS_PORT=${{Redis.REDIS_PORT}}

# ML Service (if deploying ML inference service)
ML_SERVICE_URL=http://ml-inference:8001
```

## Step 5: Update CORS After First Deployment

1. After Railway deploys your app, you'll get a URL like: `https://token-flow-api-production-xxxx.up.railway.app`
2. Go back to **Variables** and update `ALLOWED_ORIGINS`:
   ```bash
   ALLOWED_ORIGINS=https://token-flow-api-production-xxxx.up.railway.app,https://apix.com
   ```
3. Railway will automatically redeploy with the new CORS settings

## Step 6: Run Database Migrations

Railway should run migrations automatically during deployment (via `railway.json` build command).

If you need to run migrations manually:

1. Go to your service → **Settings** → **Deploy Logs**
2. Check for migration output
3. Or connect to Railway's CLI:
   ```bash
   railway login
   railway link
   railway run npm run migrate
   ```

## Step 7: Verify Deployment

### Check Health Endpoint
```bash
curl https://your-app-name.up.railway.app/health
```

Expected response:
```json
{
  "status": "healthy",
  "timestamp": "2026-02-04T...",
  "database": "connected",
  "helius": "connected"
}
```

### Check Logs
Go to your Railway service → **Deployments** → Click latest deployment → View logs

Look for:
- ✅ `Server running on port 3000`
- ✅ `Database connected`
- ✅ `Helius API initialized`

## Troubleshooting

### ❌ Error: "Helius API key not configured"

**Fix**: Make sure you set `HELIUS_API_KEY` in Railway's environment variables (not in code)

### ❌ Error: "Database connection failed"

**Fix**: Verify PostgreSQL database is running and environment variables are set correctly:
```bash
POSTGRES_HOST=${{Postgres.PGHOST}}
POSTGRES_PORT=${{Postgres.PGPORT}}
# etc.
```

### ❌ Error: "APIX_WEBHOOK_SECRET not configured"

**Fix**: Add `APIX_WEBHOOK_SECRET` to Railway's environment variables (required for webhook security)

### ❌ Build Failed

Check Railway deploy logs for specific errors. Common issues:
- Missing dependencies in `package.json`
- TypeScript compilation errors
- Wrong Node.js version (Railway uses Node 18+ by default)

## Security Checklist

Before going live with APIX integration, run security validation:

```bash
# Locally (before pushing to GitHub)
./scripts/validate-security.sh

# Test APIX security (requires app to be running)
./scripts/test-apix-security.sh
```

## Costs

Railway pricing:
- **Hobby Plan**: $5/month (500 hours of execution time)
- **PostgreSQL**: Included in Hobby plan
- **Bandwidth**: 100GB/month included

Estimated monthly cost: **$5-10** depending on usage

## Post-Deployment Steps

1. ✅ Update APIX marketplace with your Railway URL
2. ✅ Test webhook integration with APIX
3. ✅ Monitor Railway logs for any errors
4. ✅ Set up alerts in Railway dashboard

## Railway CLI (Optional)

Install Railway CLI for easier management:

```bash
# Install
npm i -g @railway/cli

# Login
railway login

# Link to project
railway link

# View logs
railway logs

# Run commands in Railway environment
railway run npm run migrate
```

## Support

- Railway Docs: https://docs.railway.app
- Railway Discord: https://discord.gg/railway
- APIX Support: https://apix.com/support
