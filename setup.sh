#!/bin/bash
# setup.sh — first-time setup for the persona repo.
#
# Configures .env, vault skeleton, persona files; then either starts the
# Docker container or prints native-host instructions. Idempotent; safe to
# re-run when switching vaults or rotating tokens.

set -euo pipefail
cd "$(dirname "$0")"

# ============ language ============
LANG_CODE=""
while [ -z "$LANG_CODE" ]; do
  read -rp "Language / 语言 (zh / en) [zh]: " lang_in
  case "${lang_in:-zh}" in
    zh|cn|中文)        LANG_CODE="zh"; LANG_NAME="中文" ;;
    en|english|英文)   LANG_CODE="en"; LANG_NAME="English" ;;
    *) echo "  ? please answer zh or en";;
  esac
done

t() { if [ "$LANG_CODE" = "en" ]; then printf '%s' "$2"; else printf '%s' "$1"; fi; }
say() { t "$@"; printf '\n'; }

# ============ load existing .env (so re-runs default to current values) ============
if [ -f .env ]; then
  set -a; . ./.env; set +a
fi

# ============ TELEGRAM_BOT_TOKEN ============
echo
say "→ Telegram bot 配置（从 @BotFather 获取 token：/newbot 后复制）" \
    "→ Telegram bot setup (get a token from @BotFather: /newbot, then copy)"
while true; do
  default="${TELEGRAM_BOT_TOKEN:-}"
  if [ -n "$default" ]; then
    read -rp "$(t "Telegram bot token [当前已设，回车保留]" "Telegram bot token [current value kept on Enter]"): " token
    token="${token:-$default}"
  else
    read -rp "$(t "Telegram bot token" "Telegram bot token"): " token
  fi
  [ -z "$token" ] && { echo "  ? $(t "不能为空" "cannot be empty")"; continue; }
  resp=$(curl -s "https://api.telegram.org/bot${token}/getMe" || echo '{}')
  if echo "$resp" | grep -q '"ok":true'; then
    bot_username=$(echo "$resp" | grep -oE '"username":"[^"]*"' | head -1 | cut -d'"' -f4)
    echo "  ✓ $(t "验证通过" "validated") (@$bot_username)"
    TELEGRAM_BOT_TOKEN="$token"
    break
  fi
  echo "  ✗ $(t "token 无效，请重试" "invalid token, try again")"
done

# ============ TELEGRAM_CHAT_ID ============
echo
say "→ 你的 chat_id（发消息给 @userinfobot 获取；先给你的 bot 发一条消息，bot 才能 reach 你）" \
    "→ Your chat_id (message @userinfobot to get it; you must message the bot first so it can reach you)"
while true; do
  default="${TELEGRAM_CHAT_ID:-}"
  if [ -n "$default" ]; then
    read -rp "$(t "Telegram chat_id [当前已设，回车保留]" "Telegram chat_id [current value kept on Enter]"): " chat_id
    chat_id="${chat_id:-$default}"
  else
    read -rp "$(t "Telegram chat_id" "Telegram chat_id"): " chat_id
  fi
  [ -z "$chat_id" ] && { echo "  ? $(t "不能为空" "cannot be empty")"; continue; }
  test_msg=$(t "Setup 测试 — 看到这条说明 bot 能找到你 ✓" "Setup test — if you see this, the bot can reach you ✓")
  resp=$(curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${chat_id}" \
    --data-urlencode "text=${test_msg}" || echo '{}')
  if echo "$resp" | grep -q '"ok":true'; then
    echo "  ✓ $(t "测试消息已发，请检查 Telegram" "test message sent, check your Telegram")"
    TELEGRAM_CHAT_ID="$chat_id"
    break
  fi
  echo "  ✗ $(t "发送失败 — 确认 chat_id 正确并已先给 bot 发过消息" "send failed — make sure chat_id is right and you've messaged the bot first")"
done

# ============ VAULT_PATH ============
echo
default_vault="${VAULT_PATH:-./Obsidian}"
read -rp "$(t "Obsidian vault 路径" "Obsidian vault path") [$default_vault]: " vault_in
vault_in="${vault_in:-$default_vault}"
mkdir -p "$vault_in"
VAULT_PATH=$(cd "$vault_in" && pwd)
echo "  ✓ vault: $VAULT_PATH"

# ============ write .env ============
echo
say "→ 写入 .env" "→ Writing .env"
touch .env
set_kv() {  # set_kv KEY VALUE  (portable in-place edit via temp file)
  local key="$1" val="$2"
  if grep -qE "^${key}=" .env; then
    local tmp; tmp=$(mktemp)
    awk -v k="$key" -v v="$val" '
      $0 ~ "^"k"=" { print k"="v; next }
      { print }
    ' .env > "$tmp" && mv "$tmp" .env
  else
    printf '%s=%s\n' "$key" "$val" >> .env
  fi
}
set_kv TELEGRAM_BOT_TOKEN "$TELEGRAM_BOT_TOKEN"
set_kv TELEGRAM_CHAT_ID   "$TELEGRAM_CHAT_ID"
set_kv VAULT_PATH         "\"$VAULT_PATH\""
echo "  ✓ .env"

# ============ vault skeleton + persona files ============
echo
say "→ 初始化 vault 骨架" "→ Initializing vault skeleton"

mkdir -p "$VAULT_PATH/persona/.claude/skills" "$VAULT_PATH/raw" "$VAULT_PATH/kb"

[ -f "$VAULT_PATH/STRUCTURE.md" ]        || cp STRUCTURE.example.md "$VAULT_PATH/STRUCTURE.md"
[ -f "$VAULT_PATH/persona/CLAUDE.md" ]   || cp CLAUDE.example.md    "$VAULT_PATH/persona/CLAUDE.md"
[ -f "$VAULT_PATH/persona/USER.md" ]     || cp USER.example.md      "$VAULT_PATH/persona/USER.md"
[ -f "$VAULT_PATH/persona/IDENTITY.md" ] || cp IDENTITY.example.md  "$VAULT_PATH/persona/IDENTITY.md"

# Prefill USER.md Language field if it's still "not set"
if grep -q "^- \*\*Language:\*\* not set" "$VAULT_PATH/persona/USER.md"; then
  tmp=$(mktemp)
  awk -v lang="$LANG_NAME" '
    /^- \*\*Language:\*\* not set/ { print "- **Language:** " lang; next }
    { print }
  ' "$VAULT_PATH/persona/USER.md" > "$tmp" && mv "$tmp" "$VAULT_PATH/persona/USER.md"
fi

# Repo-root CLAUDE.md (gitignored real file, synced via pbackup/pstore)
[ -f CLAUDE.md ] || cp CLAUDE.example.md CLAUDE.md

# Optional kb-impl starter
if [ ! -d "$VAULT_PATH/persona/.claude/skills/kb-impl" ] && [ ! -d ".claude/skills/kb-impl" ]; then
  read -rp "$(t "复制 minimal kb-impl 模板？" "Copy minimal kb-impl starter?") [Y/n]: " kb_yn
  if [ "${kb_yn:-Y}" != "n" ] && [ "${kb_yn:-Y}" != "N" ]; then
    cp -r .claude/skills/kb/examples/minimal .claude/skills/kb-impl
    echo "  ✓ kb-impl"
  fi
fi

# Pull any existing personal skills / CLAUDE.md from vault into repo
bash bin/pstore.sh > /dev/null 2>&1 || true
echo "  ✓ $(t "vault 完成" "vault ready")"

# ============ deployment mode ============
echo
say "→ 部署方式" "→ Deployment mode"
echo "  1) Docker $(t "（推荐，隔离环境）" "(recommended, isolated)")"
echo "  2) $(t "本地 host（需要 bun + @anthropic-ai/claude-code 已装）" "Native host (requires bun + @anthropic-ai/claude-code installed)")"
while true; do
  read -rp "$(t "选择" "Choose") (1/2) [1]: " mode
  case "${mode:-1}" in
    1) MODE="docker"; break ;;
    2) MODE="host";   break ;;
    *) echo "  ? 1 or 2";;
  esac
done

if [ "$MODE" = "docker" ]; then
  command -v docker >/dev/null 2>&1 || {
    say "  ✗ Docker 没装；装好再 ./setup.sh 重跑" "  ✗ Docker not installed; install it then re-run ./setup.sh"
    exit 1
  }
  echo
  say "→ Docker 启动中（首次会 build，几分钟）" "→ Starting Docker (first build takes a few minutes)"
  docker compose up -d --build
  echo
  say "✓ 容器已启动 — 下一步：" "✓ container running — next steps:"
  echo "    docker compose exec persona claude /login"
  say "      （登录 Claude Code，container 里只需做一次）" "      (login to Claude Code; one-time inside the container)"
  say "    然后给你的 Telegram bot 发一条消息触发 onboarding" "    Then send your Telegram bot a message to trigger onboarding"
else
  echo
  say "→ 本地运行模式" "→ Native host mode"
  say "  1) 确保已装 bun 和 claude code：" "  1) Ensure bun and claude code are installed:"
  echo "       brew install oven-sh/bun/bun"
  echo "       npm i -g @anthropic-ai/claude-code"
  echo "  2) bun install"
  echo "  3) claude /login"
  echo "  4) claude /assistant-loop"
  say "  5) 给你的 Telegram bot 发一条消息触发 onboarding" "  5) Send your Telegram bot a message to trigger onboarding"
fi

echo
say "✓ Setup 完成" "✓ Setup complete"
