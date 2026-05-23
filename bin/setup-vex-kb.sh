#!/bin/bash
# One-time setup: clone Quartz, configure for VEX KB, push to GitHub.
# Run this on your LOCAL machine (not in Docker).
#
# Prerequisites:
#   - git, node >= 20, npm
#   - GitHub repo already created: https://github.com/gaxxx/vex-team
#   - Run: gh auth login  (or set GITHUB_TOKEN)

set -euo pipefail

GITHUB_USER="gaxxx"
REPO_NAME="vex-team"
SITE_URL="vex-team.pages.dev"
SITE_TITLE="VEX IQ Level Up 2026-2027"
VAULT_VEX_DIR="${VAULT_PATH:-/vault}/kb/vex"

WORK_DIR="$(pwd)/${REPO_NAME}"

echo "==> Cloning Quartz v4..."
git clone https://github.com/jackyzha0/quartz.git "$WORK_DIR"
cd "$WORK_DIR"

echo "==> Removing Quartz default sample content..."
rm -rf content/*

echo "==> Patching quartz.config.ts..."
# Update baseUrl
sed -i.bak "s|baseUrl: \"quartz.jzhao.xyz\"|baseUrl: \"${SITE_URL}\"|g" quartz.config.ts
# Update pageTitle
sed -i.bak "s|pageTitle: \"Quartz 4\"|pageTitle: \"${SITE_TITLE}\"|g" quartz.config.ts
# Disable analytics
sed -i.bak "s|analytics: {|analytics: null, // {|g" quartz.config.ts
rm -f quartz.config.ts.bak

echo "==> Creating .gitignore additions..."
cat >> .gitignore << 'EOF'
# Quartz build output (built by Cloudflare Pages)
public/
EOF

echo "==> Copying VEX KB content..."
if [ -d "$VAULT_VEX_DIR" ]; then
  cp -r "$VAULT_VEX_DIR"/. content/
  echo "    Copied from $VAULT_VEX_DIR"
else
  echo "    WARNING: $VAULT_VEX_DIR not found. Add content manually to content/"
fi

echo "==> Creating index note..."
cat > content/index.md << EOF
---
tags: [vex, index]
updated: $(date +%Y-%m-%d)
---
# VEX IQ Level Up 2026-2027 知识库

队内共享资料，包括赛事规则、机器人设计和比赛策略。

## 内容

- [[level-up-rules]] — 游戏规则与赛制
- [[level-up-strategy]] — 机器人设计与策略
- [[getting-started]] — VEX IQ 入门
EOF

echo "==> Setting remote to gaxxx/vex-team..."
git remote set-url origin "https://github.com/${GITHUB_USER}/${REPO_NAME}.git"

echo "==> Installing Quartz dependencies..."
npm ci

echo "==> Initial commit and push..."
git add -A
git commit -m "feat: initial VEX IQ Level Up knowledge base"
git push -u origin main

echo ""
echo "✓ Done! Repo pushed to https://github.com/${GITHUB_USER}/${REPO_NAME}"
echo ""
echo "Next steps:"
echo "  1. Go to https://dash.cloudflare.com/ → Pages → Create a project"
echo "  2. Connect to GitHub → select ${GITHUB_USER}/${REPO_NAME}"
echo "  3. Build settings:"
echo "       Framework preset: None"
echo "       Build command:    npx quartz build"
echo "       Output directory: public"
echo "       Node version:     20 (set in Environment Variables: NODE_VERSION=20)"
echo "  4. Deploy → your site will be at https://${SITE_URL}"
echo "  5. Then set up Cloudflare Access (see docs in bin/cloudflare-access-setup.md)"
