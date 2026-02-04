#!/bin/bash
# Cleanup Personal Information Script
# Removes all references to "Samet Parlak" and personal paths

set -e  # Exit on error

echo "🛡️  Cleaning personal information from codebase..."
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 1. Remove personal paths from all markdown files
echo "📝 Step 1: Cleaning file paths in documentation..."
find . -name "*.md" -type f ! -path "./node_modules/*" -exec sed -i '' 's|/Users/sametparlak/token-flow-api|.|g' {} \;
find . -name "*.md" -type f ! -path "./node_modules/*" -exec sed -i '' 's|/Users/sametparlak/||g' {} \;
find . -name "*.md" -type f ! -path "./node_modules/*" -exec sed -i '' 's|sametparlak|<username>|g' {} \;
echo -e "${GREEN}✓ File paths cleaned${NC}"

# 2. Remove sensitive audit/deployment docs
echo ""
echo "📄 Step 2: Removing sensitive documentation..."
SENSITIVE_DOCS=(
  "AUDIT_FIXES_ROUND_2.md"
  "READY_TO_DEPLOY.md"
  "HELIUS_KEY_ROTATION.md"
  "SECURITY_READINESS.md"
  "RAILWAY_DEPLOY.md"
  "APIX_DEPLOYMENT_GUIDE.md"
  "FIXES_COMPLETED.md"
  "VERIFICATION.md"
  "COMPREHENSIVE_SECURITY_AUDIT_2026.md"
  "SECURITY_VERIFICATION_REPORT.md"
)

for doc in "${SENSITIVE_DOCS[@]}"; do
  if [ -f "$doc" ]; then
    rm -f "$doc"
    echo -e "  ${YELLOW}✓ Removed $doc${NC}"
  fi
done

# 3. Verify .env is in .gitignore
echo ""
echo "🔒 Step 3: Verifying .env protection..."
if ! grep -q "^\.env$" .gitignore 2>/dev/null; then
    echo ".env" >> .gitignore
    echo -e "${GREEN}✓ Added .env to .gitignore${NC}"
else
    echo -e "${GREEN}✓ .env already in .gitignore${NC}"
fi

# 4. Create clean .env.example without secrets
echo ""
echo "📋 Step 4: Creating clean .env.example..."
cat > .env.example << 'EOF'
# Helius API (Get your key from https://helius.xyz)
HELIUS_API_KEY=your_helius_api_key_here
HELIUS_CLUSTER=mainnet-beta

# Database
POSTGRES_HOST=postgres
POSTGRES_PORT=5432
POSTGRES_DB=token_flow_db
POSTGRES_USER=token_flow_user
POSTGRES_PASSWORD=your_secure_database_password_here

# Redis
REDIS_HOST=redis
REDIS_PORT=6379

# ML Service
ML_SERVICE_URL=http://ml-inference:8001

# Admin API Key for ML Training (generate with: openssl rand -hex 32)
ADMIN_API_KEY=your_admin_key_here

# API Configuration
PORT=3000
NODE_ENV=development

# API Key Salt (generate with: openssl rand -hex 32)
API_KEY_SALT=your_random_salt_for_api_keys_here

# APIX Webhook Secret (get from APIX dashboard)
APIX_WEBHOOK_SECRET=your_apix_webhook_secret_here
EOF
echo -e "${GREEN}✓ Created clean .env.example${NC}"

# 5. Check for any remaining personal references
echo ""
echo "🔍 Step 5: Scanning for remaining personal info..."
FOUND=0

# Check for "samet" or "parlak" (case insensitive)
if grep -ri "samet\|parlak" --include="*.ts" --include="*.js" --include="*.json" --exclude-dir=node_modules . 2>/dev/null | grep -v ".env" | head -5; then
    echo -e "${RED}⚠️  Found potential personal references in code${NC}"
    FOUND=1
else
    echo -e "${GREEN}✓ No personal references in source code${NC}"
fi

# 6. Set up .gitattributes to prevent .env commit
echo ""
echo "🔐 Step 6: Adding extra .env protection..."
cat > .gitattributes << 'EOF'
# Prevent .env from being committed (extra safety)
.env filter=secret
*.env filter=secret
EOF

cat > .git/config.local << 'EOF' 2>/dev/null || true
[filter "secret"]
    clean = "echo 'ERROR: Attempted to commit .env file!' >&2; exit 1"
EOF
echo -e "${GREEN}✓ Added .gitattributes protection${NC}"

# 7. Create anonymous git config
echo ""
echo "🎭 Step 7: Configuring anonymous git identity..."
git config user.name "Token Flow API Team"
git config user.email "noreply@tokenflow.dev"
echo -e "${GREEN}✓ Git identity set to anonymous${NC}"

# 8. Verify cleanup
echo ""
echo "═══════════════════════════════════════"
echo "✅ Cleanup Complete!"
echo "═══════════════════════════════════════"
echo ""
echo "📊 Summary:"
echo "  ✓ File paths cleaned in documentation"
echo "  ✓ Sensitive audit reports removed"
echo "  ✓ .env protected in .gitignore"
echo "  ✓ Clean .env.example created"
echo "  ✓ Git identity anonymized"
echo ""

if [ $FOUND -eq 1 ]; then
    echo -e "${YELLOW}⚠️  WARNING: Found some personal references - please review${NC}"
    echo ""
fi

echo "📝 Next Steps:"
echo "  1. Review changes: git status"
echo "  2. Check .env is NOT tracked: git check-ignore .env"
echo "  3. Commit: git add . && git commit -m 'Initial commit'"
echo "  4. Push to GitHub: git remote add origin <your-repo>"
echo ""
echo "🚀 Ready to deploy to GitHub and Railway!"
