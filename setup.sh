#!/bin/bash
# setup.sh — first-time setup for the persona repo.
#
# Configures .env, vault skeleton, persona files; then either starts the
# Docker container or prints native-host instructions. Idempotent; safe to
# re-run when switching vaults or rotating tokens.

set -euo pipefail
cd "$(dirname "$0")"

# ============ fast path: change one key, keep the rest ============
# `./setup.sh --vault [PATH]` repoints VAULT_PATH only — no Telegram re-validation,
# no other prompts. Every other line in .env is left untouched. PATH is optional;
# if omitted you're prompted (defaulting to the current value).
if [ "${1:-}" = "--vault" ]; then
  [ -f .env ] && { set -a; . ./.env; set +a; }
  default_vault="${VAULT_PATH:-./Obsidian}"
  if [ -n "${2:-}" ]; then
    vault_in="$2"
  else
    read -rp "Obsidian vault path [$default_vault]: " vault_in
    vault_in="${vault_in:-$default_vault}"
  fi
  mkdir -p "$vault_in"
  new_vault=$(cd "$vault_in" && pwd)
  touch .env
  if grep -qE '^VAULT_PATH=' .env; then
    tmp=$(mktemp)
    awk -v v="\"$new_vault\"" '/^VAULT_PATH=/{print "VAULT_PATH="v; next} {print}' .env > "$tmp" && mv "$tmp" .env
  else
    printf 'VAULT_PATH="%s"\n' "$new_vault" >> .env
  fi
  echo "✓ VAULT_PATH = $new_vault"
  echo "  (all other .env values untouched)"
  if [ ! -f "$new_vault/persona/CLAUDE.md" ]; then
    echo "  ! this vault has no persona/ skeleton yet — run ./setup.sh (full) once to populate it"
  fi
  exit 0
fi

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

# ============ register bot commands ============
# Idempotent: setMyCommands replaces the full list. Re-runs of setup.sh
# refresh whatever is currently here. Edit this JSON to change the menu.
echo
say "→ 注册 bot 命令菜单" "→ Registering bot command menu"
resp=$(curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setMyCommands" \
  -H "Content-Type: application/json" \
  --data '{"commands":[{"command":"stats","description":"查看 daemon 统计 / today usage"}]}' \
  || echo '{}')
if echo "$resp" | grep -q '"ok":true'; then
  echo "  ✓ /stats"
else
  say "  ! 命令注册失败（不影响其它步骤）：$resp" "  ! command registration failed (non-fatal): $resp"
fi

# ============ VAULT_PATH ============
echo
default_vault="${VAULT_PATH:-./Obsidian}"
read -rp "$(t "Obsidian vault 路径" "Obsidian vault path") [$default_vault]: " vault_in
vault_in="${vault_in:-$default_vault}"
mkdir -p "$vault_in"
VAULT_PATH=$(cd "$vault_in" && pwd)
echo "  ✓ vault: $VAULT_PATH"

# ============ timezone ============
echo
detect_tz() {
  if [ -r /etc/timezone ]; then
    tr -d '[:space:]' < /etc/timezone
  elif [ -L /etc/localtime ]; then
    readlink /etc/localtime | sed -E 's|.*/zoneinfo/||'
  fi
}
detected_tz=$(detect_tz)
default_tz="${TZ:-${detected_tz:-America/New_York}}"
say "→ 时区（用于 cron 调度，IANA 格式）" "→ Timezone (for cron scheduling, IANA name)"
while true; do
  read -rp "$(t "时区" "Timezone") [$default_tz]: " tz_in
  TZ="${tz_in:-$default_tz}"
  if [ -f "/usr/share/zoneinfo/$TZ" ]; then
    echo "  ✓ TZ: $TZ"
    break
  fi
  echo "  ✗ $(t "未知时区，请用 IANA 格式（例: Asia/Shanghai, Europe/London, America/Los_Angeles）" "unknown TZ — use IANA format (e.g., Asia/Shanghai, Europe/London, America/Los_Angeles)")"
done

# ============ API / model provider ============
# Three ways to feed Claude Code:
#   1) OAuth        — `claude /login`, a Claude subscription. No key in .env.
#   2) Anthropic API key — official api.anthropic.com, billed per token.
#   3) OpenRouter router — bin/anthropic-router.ts (watchdog-supervised) rewrites
#      each request's model by content: text → text model, image → vision model.
# Only the router splits vision/text — Anthropic's own models are unified
# multimodal, so options 1 & 2 use one model for both.
echo
say "→ 模型来源 / API" "→ Model provider / API"
echo "  1) $(t "Anthropic OAuth（claude /login — Claude 订阅，不走路由）" "Anthropic OAuth (claude /login — Claude subscription, no router)")"
echo "  2) $(t "Anthropic API key（官方 api.anthropic.com，按 token 计费）" "Anthropic API key (official api.anthropic.com, billed per token)")"
echo "  3) $(t "OpenRouter 本地路由（text→文本模型, 含图→视觉模型）" "OpenRouter via local router (text→text model, images→vision model)")"
# Default to whatever the existing .env implies.
prov_default=1
[ -n "${ANTHROPIC_API_KEY:-}" ] && prov_default=2
[ -n "${ANTHROPIC_BASE_URL:-}" ] && prov_default=3
while true; do
  read -rp "$(t "选择" "Choose") (1/2/3) [$prov_default]: " p_choice
  case "${p_choice:-$prov_default}" in
    1) PROVIDER="oauth";  break ;;
    2) PROVIDER="apikey"; break ;;
    3) PROVIDER="router"; break ;;
    *) echo "  ? 1, 2 or 3";;
  esac
done

if [ "$PROVIDER" = "apikey" ]; then
  # --- official Anthropic API key (validated against /v1/models) ---
  while true; do
    default="${ANTHROPIC_API_KEY:-}"
    if [ -n "$default" ]; then
      read -rp "$(t "Anthropic API key [当前已设，回车保留]" "Anthropic API key [current value kept on Enter]"): " ak
      ak="${ak:-$default}"
    else
      read -rp "$(t "Anthropic API key (sk-ant-...)" "Anthropic API key (sk-ant-...)"): " ak
    fi
    [ -z "$ak" ] && { echo "  ? $(t "不能为空" "cannot be empty")"; continue; }
    resp=$(curl -s https://api.anthropic.com/v1/models \
      -H "x-api-key: $ak" -H "anthropic-version: 2023-06-01" || echo '{}')
    if echo "$resp" | grep -qE '"data"|"type":[[:space:]]*"model"'; then
      echo "  ✓ $(t "key 有效" "key valid")"
      ANTHROPIC_API_KEY="$ak"; break
    fi
    echo "  ✗ $(t "key 无效或网络问题，重试" "invalid key or network issue, retry")"
  done

elif [ "$PROVIDER" = "router" ]; then
  # --- OpenRouter API key (validated against /api/v1/key) ---
  while true; do
    default="${OPENROUTER_API_KEY:-}"
    if [ -n "$default" ]; then
      read -rp "$(t "OpenRouter API key [当前已设，回车保留]" "OpenRouter API key [current value kept on Enter]"): " ork
      ork="${ork:-$default}"
    else
      read -rp "$(t "OpenRouter API key (sk-or-...)" "OpenRouter API key (sk-or-...)"): " ork
    fi
    [ -z "$ork" ] && { echo "  ? $(t "不能为空" "cannot be empty")"; continue; }
    resp=$(curl -s https://openrouter.ai/api/v1/key -H "Authorization: Bearer $ork" || echo '{}')
    if echo "$resp" | grep -qE '"(label|usage|limit)"'; then
      echo "  ✓ $(t "key 有效" "key valid")"
      OPENROUTER_API_KEY="$ork"; break
    fi
    echo "  ✗ $(t "key 无效或网络问题，重试" "invalid key or network issue, retry")"
  done

  # --- router model routing + port ---
  read -rp "$(t "文本模型" "Text model") [${ROUTER_TEXT_MODEL:-deepseek/deepseek-v4-pro}]: " rtm
  ROUTER_TEXT_MODEL="${rtm:-${ROUTER_TEXT_MODEL:-deepseek/deepseek-v4-pro}}"
  read -rp "$(t "视觉模型" "Vision model") [${ROUTER_VISION_MODEL:-xiaomi/mimo-v2.5}]: " rvm
  ROUTER_VISION_MODEL="${rvm:-${ROUTER_VISION_MODEL:-xiaomi/mimo-v2.5}}"
  read -rp "$(t "路由端口" "Router port") [${ROUTER_PORT:-8787}]: " rp
  ROUTER_PORT="${rp:-${ROUTER_PORT:-8787}}"

  # Derive the Anthropic-facing vars. The router rewrites body.model by content,
  # so the ANTHROPIC_*_MODEL labels below are mostly cosmetic — Claude Code sends
  # them, the router overrides them. Default each to the text model's short name,
  # but keep any value the existing .env already set.
  txt_short="${ROUTER_TEXT_MODEL##*/}"
  ANTHROPIC_BASE_URL="http://localhost:${ROUTER_PORT}"
  ANTHROPIC_AUTH_TOKEN="${ANTHROPIC_AUTH_TOKEN:-router-local}"
  ANTHROPIC_MODEL="${ANTHROPIC_MODEL:-$txt_short}"
  ANTHROPIC_DEFAULT_OPUS_MODEL="${ANTHROPIC_DEFAULT_OPUS_MODEL:-$txt_short}"
  ANTHROPIC_DEFAULT_SONNET_MODEL="${ANTHROPIC_DEFAULT_SONNET_MODEL:-$txt_short}"
  ANTHROPIC_DEFAULT_HAIKU_MODEL="${ANTHROPIC_DEFAULT_HAIKU_MODEL:-$txt_short}"
  CLAUDE_CODE_SUBAGENT_MODEL="${CLAUDE_CODE_SUBAGENT_MODEL:-$txt_short}"
  echo "  ✓ $(t "路由已配置" "router configured"): $ANTHROPIC_BASE_URL  (text=$ROUTER_TEXT_MODEL, vision=$ROUTER_VISION_MODEL)"

fi

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
unset_kv() {  # unset_kv KEY  — drop a line from .env if present
  local key="$1"
  grep -qE "^${key}=" .env || return 0
  local tmp; tmp=$(mktemp)
  grep -vE "^${key}=" .env > "$tmp" && mv "$tmp" .env
}
set_kv TELEGRAM_BOT_TOKEN "$TELEGRAM_BOT_TOKEN"
set_kv TELEGRAM_CHAT_ID   "$TELEGRAM_CHAT_ID"
set_kv VAULT_PATH         "\"$VAULT_PATH\""
set_kv TZ                 "$TZ"

# API auth vars — written per provider. The ANTHROPIC_BASE_URL/AUTH_TOKEN
# redirect and the ANTHROPIC_API_KEY are mutually exclusive auth paths, so each
# mode strips the others to avoid Claude Code picking up a stale credential.
case "$PROVIDER" in
  oauth)
    # Pure subscription login — no key, no redirect in .env.
    unset_kv ANTHROPIC_BASE_URL
    unset_kv ANTHROPIC_AUTH_TOKEN
    unset_kv ANTHROPIC_API_KEY
    ;;
  apikey)
    set_kv ANTHROPIC_API_KEY "$ANTHROPIC_API_KEY"
    unset_kv ANTHROPIC_BASE_URL
    unset_kv ANTHROPIC_AUTH_TOKEN
    ;;
  router)
    set_kv ANTHROPIC_BASE_URL             "$ANTHROPIC_BASE_URL"
    set_kv ANTHROPIC_AUTH_TOKEN           "$ANTHROPIC_AUTH_TOKEN"
    set_kv ANTHROPIC_MODEL                "$ANTHROPIC_MODEL"
    set_kv ANTHROPIC_DEFAULT_OPUS_MODEL   "$ANTHROPIC_DEFAULT_OPUS_MODEL"
    set_kv ANTHROPIC_DEFAULT_SONNET_MODEL "$ANTHROPIC_DEFAULT_SONNET_MODEL"
    set_kv ANTHROPIC_DEFAULT_HAIKU_MODEL  "$ANTHROPIC_DEFAULT_HAIKU_MODEL"
    set_kv CLAUDE_CODE_SUBAGENT_MODEL     "$CLAUDE_CODE_SUBAGENT_MODEL"
    set_kv OPENROUTER_API_KEY             "$OPENROUTER_API_KEY"
    set_kv ROUTER_TEXT_MODEL              "$ROUTER_TEXT_MODEL"
    set_kv ROUTER_VISION_MODEL            "$ROUTER_VISION_MODEL"
    set_kv ROUTER_PORT                    "$ROUTER_PORT"
    # A router redirect would shadow an official key — make sure it's gone.
    unset_kv ANTHROPIC_API_KEY
    ;;
esac
echo "  ✓ .env"

# ============ vault skeleton + persona files ============
echo
say "→ 初始化 vault 骨架" "→ Initializing vault skeleton"

mkdir -p "$VAULT_PATH/persona/.claude/skills" "$VAULT_PATH/persona/memory" "$VAULT_PATH/raw" "$VAULT_PATH/kb"

[ -f "$VAULT_PATH/STRUCTURE.md" ]        || cp STRUCTURE.example.md "$VAULT_PATH/STRUCTURE.md"
[ -f "$VAULT_PATH/persona/USER.md" ]     || cp USER.example.md      "$VAULT_PATH/persona/USER.md"
[ -f "$VAULT_PATH/persona/IDENTITY.md" ] || cp IDENTITY.example.md  "$VAULT_PATH/persona/IDENTITY.md"
[ -f "$VAULT_PATH/persona/MEMORY.md" ]   || cp MEMORY.example.md    "$VAULT_PATH/persona/MEMORY.md"
[ -f "$VAULT_PATH/persona/CRON.md" ]     || cp CRON.example.md      "$VAULT_PATH/persona/CRON.md"

# Prefill USER.md Language field if it's still "not set"
if grep -q "^- \*\*Language:\*\* not set" "$VAULT_PATH/persona/USER.md"; then
  tmp=$(mktemp)
  awk -v lang="$LANG_NAME" '
    /^- \*\*Language:\*\* not set/ { print "- **Language:** " lang; next }
    { print }
  ' "$VAULT_PATH/persona/USER.md" > "$tmp" && mv "$tmp" "$VAULT_PATH/persona/USER.md"
fi


# kb-impl: simple starter now, or roll your own later
if [ ! -d "$VAULT_PATH/persona/.claude/skills/kb-impl" ] && [ ! -d ".claude/skills/kb-impl" ]; then
  echo
  say "→ kb-impl（Knowledge Base 实现）" "→ kb-impl (knowledge-base implementation)"
  echo "  1) $(t "用简单版（minimal flat-folder 模板，可直接用）" "Use simple version (minimal flat-folder template, ready to go)")"
  echo "  2) $(t "跳过，之后自己写" "Skip — I'll write my own later")"
  while true; do
    read -rp "$(t "选择" "Choose") (1/2) [1]: " kb_choice
    case "${kb_choice:-1}" in
      1) cp -r .claude/skills/kb/examples/minimal .claude/skills/kb-impl
         echo "  ✓ $(t "已复制 minimal kb-impl" "minimal kb-impl copied")"; break ;;
      2) echo "  · $(t "稍后自己加 .claude/skills/kb-impl/" "add .claude/skills/kb-impl/ later yourself")"; break ;;
      *) echo "  ? 1 or 2";;
    esac
  done
fi

# Pull any existing personal skills / CLAUDE.md from vault into repo
bash bin/prestore.sh > /dev/null 2>&1 || true
echo "  ✓ $(t "vault 完成" "vault ready")"

# ============ Claude Code model ============
echo
say "→ Claude Code 模型" "→ Claude Code model"
echo "  1) Sonnet $(t "（推荐 — 速度/成本/能力平衡）" "(recommended — balanced speed/cost/capability)")"
echo "  2) Opus $(t "（最强但最贵）" "(most capable, most expensive)")"
echo "  3) Haiku $(t "（最快最便宜，能力较弱）" "(fastest/cheapest, less capable)")"
echo "  4) $(t "默认（Claude Code 自己决定）" "Default (let Claude Code decide)")"
while true; do
  read -rp "$(t "选择" "Choose") (1-4) [1]: " m_choice
  case "${m_choice:-1}" in
    1) CC_MODEL="sonnet"; break ;;
    2) CC_MODEL="opus";   break ;;
    3) CC_MODEL="haiku";  break ;;
    4) CC_MODEL="";       break ;;
    *) echo "  ? 1-4";;
  esac
done

# Write model to .claude/settings.local.json
if [ -n "$CC_MODEL" ]; then
  mkdir -p .claude
  if [ -f .claude/settings.local.json ]; then
    if command -v jq >/dev/null 2>&1; then
      tmp=$(mktemp)
      jq --arg m "$CC_MODEL" '.model = $m' .claude/settings.local.json > "$tmp" && mv "$tmp" .claude/settings.local.json
      echo "  ✓ model = $CC_MODEL ($(t "写入 .claude/settings.local.json" "written to .claude/settings.local.json"))"
    else
      say "  ! jq 没装，请手动在 .claude/settings.local.json 加: \"model\": \"$CC_MODEL\"" \
          "  ! jq not installed; manually add \"model\": \"$CC_MODEL\" to .claude/settings.local.json"
    fi
  else
    cat > .claude/settings.local.json <<EOF
{
  "model": "$CC_MODEL"
}
EOF
    echo "  ✓ model = $CC_MODEL ($(t "已写入 .claude/settings.local.json" "written to .claude/settings.local.json"))"
  fi
fi

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

  # On Linux hosts, bind mounts use raw UIDs — the container's bun user (UID
  # 1000) needs to own /workspace and /vault to write logs / persona files.
  # macOS Docker Desktop's osxfs auto-translates UIDs so no chown needed.
  if [ "$(uname -s)" = "Linux" ]; then
    echo
    say "→ chown 1000 -R . $VAULT_PATH（容器 bun 用户需要写权限）" \
        "→ chown 1000 -R . $VAULT_PATH (container's bun user needs write access)"
    if chown -R 1000 . "$VAULT_PATH" 2>/dev/null; then
      echo "  ✓ chown done"
    elif command -v sudo >/dev/null 2>&1; then
      sudo chown -R 1000 . "$VAULT_PATH"
      echo "  ✓ chown done (with sudo)"
    else
      say "  ✗ chown 失败且没 sudo — 手动跑: chown -R 1000 . $VAULT_PATH" \
          "  ✗ chown failed and no sudo — run manually: chown -R 1000 . $VAULT_PATH"
      exit 1
    fi
  fi

  echo
  say "✓ Setup 完成 — 运行：" "✓ Setup complete — run:"
  echo "       ./run_docker.sh"
  say "  （首次 build 需几分钟；attach 后 Ctrl-B D detach）" \
      "  (first build takes a few minutes; Ctrl-B D to detach from tmux)"
  say "  给你的 Telegram bot 发一条消息触发 onboarding" "  Send your Telegram bot a message to trigger onboarding"
else
  echo
  say "→ 本地运行模式" "→ Native host mode"
  say "  依赖（如未安装）：" "  Prerequisites (if not installed):"
  echo "       brew install oven-sh/bun/bun"
  echo "       npm i -g @anthropic-ai/claude-code"
  echo "       bun install"
  if [ "${PROVIDER:-oauth}" = "oauth" ]; then
    say "       claude /login  （首次登录）" "       claude /login  (first time only)"
  fi
  echo
  say "  然后直接运行：" "  Then just run:"
  echo "       ./run_local.sh"
  say "  并给你的 Telegram bot 发一条消息触发 onboarding" "  Send your Telegram bot a message to trigger onboarding"
fi

echo
say "✓ Setup 完成" "✓ Setup complete"
