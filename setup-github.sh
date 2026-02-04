#!/bin/bash

# Token Flow API - GitHub Setup Script
# This script automates the git setup and push to GitHub

set -e  # Exit on any error

echo "🚀 Token Flow API - GitHub Setup"
echo "================================"
echo ""

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if we're in the right directory
if [ ! -f "package.json" ]; then
    echo "❌ Error: Not in token-flow-api directory"
    echo "Please run this script from /Users/sametparlak/token-flow-api"
    exit 1
fi

echo -e "${BLUE}Step 1: Git Initialization${NC}"
echo "-------------------------"

# Initialize git if not already done
if [ ! -d ".git" ]; then
    echo "Initializing git repository..."
    git init
    echo -e "${GREEN}✓ Git initialized${NC}"
else
    echo -e "${GREEN}✓ Git already initialized${NC}"
fi

echo ""
echo -e "${BLUE}Step 2: Configure Git (if needed)${NC}"
echo "-------------------------"

# Check if git user is configured
if [ -z "$(git config user.name)" ]; then
    echo "Git user not configured. Please enter your details:"
    read -p "Your Name: " git_name
    read -p "Your Email: " git_email
    git config user.name "$git_name"
    git config user.email "$git_email"
    echo -e "${GREEN}✓ Git user configured${NC}"
else
    echo -e "${GREEN}✓ Git user already configured as: $(git config user.name)${NC}"
fi

echo ""
echo -e "${BLUE}Step 3: Stage All Files${NC}"
echo "-------------------------"
git add .
echo -e "${GREEN}✓ All files staged${NC}"

# Show what will be committed
echo ""
echo "Files to be committed:"
git status --short | head -20
file_count=$(git status --short | wc -l)
if [ $file_count -gt 20 ]; then
    echo "... and $((file_count - 20)) more files"
fi

echo ""
echo -e "${BLUE}Step 4: Create Initial Commit${NC}"
echo "-------------------------"

# Check if there are any commits yet
if git rev-parse HEAD >/dev/null 2>&1; then
    echo "Repository already has commits. Creating new commit..."
    git commit -m "Prepare for Railway deployment with APIX integration

- Complete user management system
- API key generation (tfa_live_ format)
- APIX webhook integration
- Usage tracking and analytics
- Pay-per-call pricing model
- Database migrations ready
- OpenAPI 3.0 specification
- Railway deployment configuration
- Security enhancements and validation"
else
    echo "Creating initial commit..."
    git commit -m "Initial commit: Token Flow API with APIX integration

Features:
- Token flow tracking and analysis
- Risk assessment with ML
- Transaction tracing
- User management and API keys
- APIX marketplace integration
- Pay-per-call pricing
- Railway-ready deployment

Ready for production deployment!"
fi

echo -e "${GREEN}✓ Commit created${NC}"

echo ""
echo -e "${BLUE}Step 5: Set Main Branch${NC}"
echo "-------------------------"
git branch -M main
echo -e "${GREEN}✓ Branch renamed to 'main'${NC}"

echo ""
echo "================================"
echo -e "${YELLOW}⏸  MANUAL STEP REQUIRED${NC}"
echo "================================"
echo ""
echo "Now you need to create a GitHub repository:"
echo ""
echo "1. Go to: https://github.com/new"
echo "2. Repository name: token-flow-api"
echo "3. Description: Solana token flow analysis API with ML risk scoring"
echo "4. Visibility: Public or Private (your choice)"
echo "5. DON'T initialize with README, .gitignore, or license"
echo "6. Click 'Create repository'"
echo ""
echo "After creating the repo, you'll see a URL like:"
echo "  https://github.com/YOUR_USERNAME/token-flow-api.git"
echo ""
read -p "Paste your repository URL here: " repo_url

# Validate URL
if [[ ! $repo_url =~ ^https://github.com/.+/.+\.git$ ]] && [[ ! $repo_url =~ ^git@github.com:.+/.+\.git$ ]]; then
    echo ""
    echo "⚠️  That doesn't look like a valid GitHub URL."
    echo "Expected format: https://github.com/username/repo.git"
    echo ""
    read -p "Continue anyway? (y/n): " continue
    if [[ $continue != "y" ]]; then
        echo "Exiting. Run the script again when ready."
        exit 1
    fi
fi

echo ""
echo -e "${BLUE}Step 6: Add Remote Origin${NC}"
echo "-------------------------"

# Remove existing origin if present
if git remote | grep -q "^origin$"; then
    echo "Removing existing origin..."
    git remote remove origin
fi

git remote add origin "$repo_url"
echo -e "${GREEN}✓ Remote 'origin' added${NC}"

echo ""
echo -e "${BLUE}Step 7: Push to GitHub${NC}"
echo "-------------------------"
echo "Pushing to GitHub..."
echo "(You may be prompted for GitHub credentials)"
echo ""

# Try to push
if git push -u origin main; then
    echo ""
    echo "================================"
    echo -e "${GREEN}✅ SUCCESS!${NC}"
    echo "================================"
    echo ""
    echo "Your code is now on GitHub!"
    echo ""
    echo "Repository URL: ${repo_url%.git}"
    echo ""
    echo -e "${GREEN}Next Steps:${NC}"
    echo "1. ✅ Code pushed to GitHub"
    echo "2. 📝 Follow RAILWAY_DEPLOY.md to deploy to Railway"
    echo "3. 🚀 Register on APIX marketplace"
    echo ""
    echo "View your repo: ${repo_url%.git}"
else
    echo ""
    echo "================================"
    echo -e "${YELLOW}⚠️  PUSH FAILED${NC}"
    echo "================================"
    echo ""
    echo "This usually happens because:"
    echo "1. GitHub authentication failed"
    echo "2. Repository already has content"
    echo ""
    echo "Solutions:"
    echo ""
    echo "A) If authentication failed:"
    echo "   - Use GitHub CLI: gh auth login"
    echo "   - Or use SSH: git remote set-url origin git@github.com:username/repo.git"
    echo ""
    echo "B) If repo has content:"
    echo "   - Force push: git push -u origin main --force"
    echo "   - (Only do this if you're sure!)"
    echo ""
    echo "Manual push command:"
    echo "  git push -u origin main"
    exit 1
fi
