# 🚀 Railway Deployment Checklist

## ✅ Pre-Deployment (Completed)

- [x] Helius API key configured: `d37de030-700b-40cd-9c5f-d77c83860e5f`
- [x] APIX webhook secret generated
- [x] Security fixes implemented (CRIT-NEW-001, CRIT-NEW-002, HIGH-NEW-001)
- [x] .env file protected in .gitignore
- [x] Railway deployment guide created
- [x] Environment variables documented

## 📝 Deployment Steps

### Step 1: Push to GitHub

```bash
# Add new files
git add .gitignore RAILWAY_DEPLOY.md DEPLOYMENT_CHECKLIST.md

# Commit changes
git commit -m "Add Railway deployment configuration and security fixes"

# Push to GitHub
git push origin main
```

### Step 2: Deploy to Railway

1. Go to https://railway.app/new
2. Click **"Deploy from GitHub repo"**
3. Select your `token-flow-api` repository
4. Click **"Add variables"** and paste from `.env.railway` file

### Step 3: Add PostgreSQL Database

1. In Railway dashboard, click **"+ New"**
2. Select **"Database"** → **"PostgreSQL"**
3. Wait for database to provision

### Step 4: Configure Environment Variables

Open [.env.railway](.env.railway) and copy ALL variables to Railway:

**Your Service → Variables → Raw Editor → Paste**

### Step 5: Update CORS After Deployment

After Railway gives you a URL (e.g., `https://token-flow-api-production-xxxx.up.railway.app`):

1. Go back to **Variables**
2. Update `ALLOWED_ORIGINS`:
   ```
   ALLOWED_ORIGINS=https://token-flow-api-production-xxxx.up.railway.app,https://apix.com
   ```
3. Railway will auto-redeploy

### Step 6: Verify Deployment

```bash
# Test health endpoint
curl https://your-railway-url.up.railway.app/health

# Expected response:
# {
#   "status": "healthy",
#   "database": "connected",
#   "helius": "connected"
# }
```

### Step 7: Update APIX Marketplace

1. Go to APIX dashboard
2. Update your API endpoint URL with Railway URL
3. Set webhook secret to match `APIX_WEBHOOK_SECRET` from `.env.railway`
4. Test webhook integration

## 🔒 Security Verification

Before going live, run these tests locally:

```bash
# Validate all security configurations
./scripts/validate-security.sh

# Test APIX security fixes (requires API running)
./scripts/test-apix-security.sh
```

## 📊 Monitoring

After deployment:
- Monitor Railway logs: **Your Service → Deployments → View Logs**
- Check for errors: Look for database connection issues or API key problems
- Test APIX webhooks: Trigger a test webhook from APIX dashboard

## 🆘 Troubleshooting

### Railway deployment failed?
Check [RAILWAY_DEPLOY.md](RAILWAY_DEPLOY.md) troubleshooting section

### Helius API not working?
Verify `HELIUS_API_KEY` is set in Railway variables (not committed to code)

### Database connection errors?
Ensure PostgreSQL database is added and variables use `${{Postgres.PGHOST}}` syntax

### Webhook signature errors?
Confirm `APIX_WEBHOOK_SECRET` matches between Railway and APIX dashboard

## 💰 Estimated Costs

- Railway Hobby Plan: **$5/month**
- PostgreSQL: **Included**
- Total: **~$5-10/month** depending on usage

---

**Ready to deploy!** Follow Step 1 above to push to GitHub, then proceed with Railway deployment.
