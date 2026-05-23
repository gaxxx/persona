#!/usr/bin/env bun
/**
 * Telegram daemon: long-poll Telegram, route each message into a single
 * persistent `claude -p --input-format stream-json --output-format stream-json`
 * subprocess. The subprocess does ALL the work (loads CLAUDE.md, replies via
 * `bun run bin/tg-send.ts`, logs conversations). The daemon is just plumbing.
 *
 * Stream-json envelopes (confirmed by manual probe):
 *   stdin  -> {"type":"user","message":{"role":"user","content":"<text>"}}\n
 *   stdout -> NDJSON, multiple events per turn. Notable types:
 *              system/init, rate_limit_event, assistant, result/<subtype>
 *            A `{type:"result"}` event marks turn completion. session_id is
 *            preserved across turns within one subprocess.
 *
 * Run:  bun run bin/tg-daemon.ts
 */
import { getUpdates, downloadFile, sendTyping, sendMessage, type TelegramMessage } from "./lib/telegram";
import { registerSession } from "./lib/session-registry";
import { userDateAndHm } from "./lib/user-tz";
import { mkdirSync, existsSync, appendFileSync, statSync, readFileSync, writeFileSync } from "fs";
import type { Subprocess } from "bun";
import { loadMembers, getMemberByChatId, getMemberByUserId, getAdmin, watchMembers, type Member } from "./lib/members";
import { checkAndIncrementQuota, resetQuota, getQuotaStatus } from "./lib/quota";

const OFFSET_FILE = "data/tg-offset.json";
const LOG_FILE = "data/daemon.log";
const HEARTBEAT_FILE = "data/tg-daemon-heartbeat";
const LONG_POLL_TIMEOUT = 25;

// MCP per-server status cache, authoritative source = claude's system/init
// event. Each turn-1 of a fresh subprocess reports per-server connection
// outcome (connected / failed / needs-auth). We cache that and skip "failed"
// servers in the NEXT .mcp.json so claude doesn't waste connect-timeout time
// trying them again. Per-server exponential backoff retries (1, 2, 4, 8,
// 16 min cap) so a recovered server is re-tested within ≤16 min.
const MCP_LOCAL_PATH = ".mcp.local.json"; // source of truth (gitignored)
const MCP_OUT_PATH = ".mcp.json";          // generated, claude reads this
const MCP_STATUS_PATH = "data/mcp-status.json";
// Cap external-writes payload to keep event JSON sane. If an unusually huge
// cron output appears between turns, the payload gets truncated and claude
// can re-read the file if needed (the truncated marker is unmistakable).
const MAX_EXTERNAL_WRITES_BYTES = 4096;

// Member registry — loaded from vault/persona/members/*.md. Hot-reloads on change.
let members: Member[] = loadMembers();
watchMembers(() => {
  members = loadMembers();
  log(`members reloaded: ${members.map((m) => m.name).join(", ") || "(none)"}`);
});

// The admin member (admin.md). Used for rate-limit notifications and admin commands.
// Falls back to first member if no admin.md exists.
function adminMember(): Member | undefined {
  return getAdmin(members) ?? members[0];
}

// Track the group chat_id once we see the first group message. Used to inject
// group log path into DM subprocess PRIMINGs so they can load shared context.
let groupChatId: number | null = null;

if (!existsSync("data")) mkdirSync("data", { recursive: true });
log("entering poll loop");

function log(...parts: unknown[]) {
  const line = `[${new Date().toISOString()}] ${parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ")}\n`;
  appendFileSync(LOG_FILE, line);
  process.stdout.write(line);
}

// ---- MCP per-server status cache ------------------------------------------

interface McpServerStatus {
  status: string;                 // raw claude status: "connected" / "failed" / "needs-auth" / ...
  lastCheckedAt: number;          // epoch ms when last init event reported this
  consecutiveFailures: number;    // for exponential retry on "failed"
}

type McpStatusCache = Record<string, McpServerStatus>;

let mcpStatusCache: McpStatusCache = (() => {
  try {
    return JSON.parse(readFileSync(MCP_STATUS_PATH, "utf-8")) as McpStatusCache;
  } catch {
    return {};
  }
})();

function saveMcpStatusCache() {
  try {
    writeFileSync(MCP_STATUS_PATH, JSON.stringify(mcpStatusCache, null, 2));
  } catch (e) {
    log("mcp: save status cache failed:", (e as Error).message);
  }
}

// Per-server retry timing: 1, 2, 4, 8, 16 min cap. Server is "still
// excluded" until that delay has passed since the last failed check.
function isOnCooldown(name: string): boolean {
  const s = mcpStatusCache[name];
  if (!s || s.status === "connected" || s.status === "needs-auth") return false;
  // status is "failed" (or other unknown bad state)
  const delayMin = Math.min(2 ** s.consecutiveFailures, 16);
  const age = Date.now() - s.lastCheckedAt;
  return age < delayMin * 60_000;
}

function updateMcpStatuses(servers: Array<{ name?: string; status?: string }>): void {
  let anyChange = false;
  for (const s of servers) {
    if (!s.name || !s.status) continue;
    const prev = mcpStatusCache[s.name];
    const ok = s.status === "connected" || s.status === "needs-auth";
    const consecutiveFailures = ok ? 0 : (prev?.consecutiveFailures ?? 0) + 1;
    mcpStatusCache[s.name] = {
      status: s.status,
      lastCheckedAt: Date.now(),
      consecutiveFailures,
    };
    if (!prev || prev.status !== s.status) anyChange = true;
  }
  if (anyChange) {
    const summary = Object.entries(mcpStatusCache)
      .map(([n, v]) => `${n}=${v.status}`)
      .join(", ");
    log(`mcp: status cache updated [${summary}]`);
  }
  saveMcpStatusCache();
}

function writeMcpConfig(): void {
  if (!existsSync(MCP_LOCAL_PATH)) {
    log(`mcp: ${MCP_LOCAL_PATH} not found, leaving ${MCP_OUT_PATH} as-is`);
    return;
  }
  const local = JSON.parse(readFileSync(MCP_LOCAL_PATH, "utf-8")) as {
    mcpServers?: Record<string, unknown>;
  };
  const out: { mcpServers: Record<string, unknown> } = { mcpServers: {} };
  const skipped: string[] = [];
  for (const [name, srv] of Object.entries(local.mcpServers ?? {})) {
    if (isOnCooldown(name)) {
      const s = mcpStatusCache[name];
      const delayMin = Math.min(2 ** s.consecutiveFailures, 16);
      const retryInMs = delayMin * 60_000 - (Date.now() - s.lastCheckedAt);
      skipped.push(`${name}(retry in ${Math.round(retryInMs / 60_000)}min, ${s.consecutiveFailures} fails)`);
      continue;
    }
    out.mcpServers[name] = srv;
  }
  writeFileSync(MCP_OUT_PATH, JSON.stringify(out, null, 2) + "\n");
  if (skipped.length > 0) {
    log(`mcp: wrote ${MCP_OUT_PATH} (skipped: ${skipped.join("; ")})`);
  } else {
    log(`mcp: wrote ${MCP_OUT_PATH} (all ${Object.keys(out.mcpServers).length} servers)`);
  }
}

// ---- Claude subprocess ----------------------------------------------------

const PRIMING = `You are a personal assistant running inside a long-lived daemon process. Read CLAUDE.md and <vault>/persona/USER.md to learn who your human is.

Each user turn I send you is one Telegram event in this exact form:
  [Telegram event] {"chat_id":..., "from":"...", "text":"...", "attachment":{kind,path,name?,mime?}|undefined, "date":"...", "message_id":..., "active_threads":["slug1","slug2",...] (optional)}

If \`attachment\` is set, the user attached a single file. \`kind\` is "photo" / "document" / "sticker". \`path\` is a relative path under data/attachments/. Read it with the Read tool - Read supports images and PDFs natively. Stickers may be webp/tgs/webm; for tgs/webm just acknowledge the sticker (use \`name\` if it's an emoji). \`text\` is caption or a placeholder if none.

If \`attachments\` (plural array) is set instead, the user sent multiple files at once as a Telegram media group (e.g. 2-10 photos in a single send). Each entry has the same shape as \`attachment\`. Read all of them with the Read tool and treat them as one user turn — the caption (if any) is in \`text\` and applies to the whole group.

When you reply to a photo/document, include enough description in your reply that a future session reading the conversation log can understand what the file was about WITHOUT having to re-Read it. e.g. don't just say "好看!" — say "好看! 这盘麻婆豆腐看起来很正宗". The actual image/PDF bytes are NOT in the conversation log (only your text reply is), so your reply is the future-you's only handle to that attachment unless they re-Read it from \`data/attachments/<message_id>.*\`.

If \`reply_to\` is set, the user is replying to an earlier message. Use it as context for what they're responding to. If \`reply_to.from_bot\` is true, that prior message was from you - find it in data/conversations/YYYY-MM-DD.md to recover full context. If the replied-to had an attachment that was previously processed by this daemon, the file is at data/attachments/<reply_to.message_id>.* - Read it if relevant.

Read CLAUDE.md (in cwd) for behaviour. Use the assistant-loop skill mechanics:
read identity/user/conversation context, route to skills/MCP tools, write your
reply as your final text in the turn (the daemon auto-sends it to Telegram),
and log to data/conversations/YYYY-MM-DD.md.

Conversation log timestamps MUST be in the user's wall-clock time (per USER.md \`Timezone\`), NOT UTC. The filename's YYYY-MM-DD and the \`[HH:MM]\` prefix on each line should both reflect the user's local day. Get a correct timestamp by running \`bun run bin/lib/user-tz.ts\` (prints \`YYYY-MM-DD HH:MM <tz>\`) — never construct from \`new Date().toISOString()\`, which is UTC and rolls past midnight ~5 hours before her wall clock does.

Conversation log loading discipline (overrides the skill's "always load" step):
- FIRST turn after spawn: read today's conversation log as the skill requires.
- SUBSEQUENT turns: do NOT re-read the full log by default — your in-context memory of prior turns covers it. Re-read only when one of:
  (a) the user references past events ("yesterday" / "earlier" / "我之前说过" / "上次" / etc),
  (b) \`reply_to.from_bot=true\` (find the original message),
  (c) the event JSON contains an \`external_writes_since_last_turn\` field — those lines were written by other processes (typically cron tasks) since your last turn. Treat them as already-read context. The field's content is the raw appended text from the conversation log; you don't need to Read the file to find it. If it ends with a "[TRUNCATED N bytes …]" marker, then Read the file to get the rest.
- TRIVIAL messages (pure greetings like "你好" / "thanks" / "👍", or questions answerable from USER.md alone like "我在哪个时区"): skip reading the log entirely, even on the first turn — just answer directly.

Discussion scratchpad — \`data/scratchpad.md\`:
Multi-thread working-memory file. The conversation log preserves words but not the working frame (criteria, candidates, exclusions, leaning) for each open discussion. Scratchpad keeps that frame across subprocess rotations AND across topic switches within a day.

Structure: \`*Updated: YYYY-MM-DD HH:MM*\` header, then sections \`## Active\` / \`## Deferred\` / \`## Recently decided\`. Each thread is a \`### thread: <slug>\` block with **Touched:**, **Constraints:** (use ⚠️ prefix for hard non-negotiables the user has stated), **Candidates:**, **Status:**.

Caps: ≤8 threads total, ≤5 active, ~400 chars/thread, total file <5KB. \`## Recently decided\` entries that have aged past 24h move to \`data/decisions-log.md\` (append-only). If you would exceed 5 active threads, ping the user ("现在有 N 个开着的讨论，要不要合并/收尾几个？") rather than silently dropping.

LOAD on FIRST turn after spawn alongside the conversation log. Find the thread that matches the user's current question — that frame is authoritative.

RE-READ on every multi-turn decision turn before composing your reply (one Read, cheap). Honor ⚠️ lines on the active thread — those are constraints you already committed to, do not contradict them. Skip the re-read for one-shot answers, trivial messages, and pure conversational turns.

UPDATE on frame-change turns (one Edit/Write per turn):
- new constraint / candidate / exclusion / leaning → edit the matching thread (and bump its **Touched:** to now — stale Touched gets the thread auto-deferred)
- decided ("就这个" / "下单了" / "OK 拍") → move thread to \`## Recently decided\`, add **Decided:** time + **Result:** one-line outcome + **Archive-by:** (24h later)
- deferred ("等一等" / "8 月再说") → move to \`## Deferred\` with trigger/date
- new topic mid-day → ADD a new \`### thread:\` under \`## Active\`. NEVER overwrite other threads.

THREAD MATCHING (do this BEFORE composing any multi-turn decision reply):
- The event JSON includes \`active_threads:[slug, ...]\` — the open thread slugs from \`## Active\`, pre-extracted for you. Use it instead of re-reading the file just to enumerate slugs.
- Match on **noun + location/use case**, not noun alone. Same noun ≠ same thread:
    "镜子" + 主卫 vs "镜子" + 客厅 WIC → TWO different threads.
    "马桶" + 主卫 vs "马桶" + 客卫 → TWO different threads.
- If exactly one slug matches → Read that thread's body, honor its ⚠️ lines, compose.
- If none matches → ADD a new \`### thread:\` BEFORE composing. Don't silently merge into the nearest-noun thread.
- If multiple slugs could match and the user wasn't specific → ASK which one ("是说主卫那面镜子还是客厅 WIC 那面？") rather than guess. One short clarifying question beats 30 minutes of misaligned recommendations.

Skip the scratchpad entirely for one-shot answers and trivial messages.

Do NOT start a Monitor or any watcher - the daemon owns Telegram polling.
Do NOT call tg-pull.ts.

Replying to the user: write your reply as the final text of your turn — the daemon auto-sends it to Telegram. You don't need to call tg-send.ts for ordinary text replies.

Only call \`bin/tg-send.ts\` explicitly when:
- splitting one logical reply across multiple Telegram messages
- sending an extra message after you've already used Bash this turn for something else (auto-send may dedupe in edge cases)
- composing a message you want sent BEFORE doing further work in the same turn (e.g., "let me check..." → tool calls → final reply)

CRITICAL: tg-send.ts reads the body from **stdin only** (argv body is rejected). Always use a heredoc — argv quoting breaks on embedded \`"\`, inches \`''\`, or any Chinese punctuation that triggers shell word-splitting:

\`\`\`bash
cat <<'EOF' | bun run bin/tg-send.ts <chat_id>
your message here, with " and ' and 中文 freely
EOF
\`\`\`

Use \`<<'EOF'\` (single-quoted heredoc tag) so the body is NOT interpolated by bash — backticks, \\$vars, and special chars all pass through unchanged.

For photos (everyday snapshots, casual images): \`bin/tg-send-photo.ts <chat_id> <filepath> [caption]\` — this uses Telegram's sendPhoto which compresses + downscales for display.

For **engineering drawings, dimensional diagrams, screenshots with fine labels, HTML, SVG, PDF, or anything where preserving exact pixels matters**: use \`bin/tg-send-doc.ts <chat_id> <filepath> [caption]\` — uploads via sendDocument so Telegram doesn't compress. HTML/SVG/PDF auto-get the right MIME so they open correctly. **Rule of thumb: any image with text labels (numbers, dimensions, code) → use tg-send-doc.** sendPhoto will turn a 1200px SVG render with 32px labels into something unreadable.

For typing indicators use \`bin/tg-typing.ts\`. If any tg-send / tg-send-photo / tg-send-doc call happens in a turn, the daemon does NOT auto-send your final text — so include all the text you want sent in those explicit calls.

Acknowledge with the single word READY.`;

function buildDmPriming(member: Member, knownGroupChatId: number | null): string {
  const dmLogDir = `data/conversations/dm-${member.telegram_chat_id}`;
  const profileLine = member.is_admin
    ? `Read CLAUDE.md and <vault>/persona/USER.md to learn who your human is.`
    : `Read CLAUDE.md and <vault>/persona/members/${member.filename} to learn about ${member.name}${member.role ? ` (${member.role})` : ""}.`;
  const groupNote = knownGroupChatId !== null
    ? `\nAlso read data/conversations/group-${knownGroupChatId}/<date>.md on the first turn to share context with the group channel (all context is public).`
    : "";
  return PRIMING
    .replace(
      `Read CLAUDE.md and <vault>/persona/USER.md to learn who your human is.`,
      profileLine + groupNote,
    )
    .replace(/data\/conversations\/YYYY-MM-DD\.md/g, `${dmLogDir}/YYYY-MM-DD.md`);
}

function buildGroupPriming(allMembers: Member[], chatId: number): string {
  const groupLogDir = `data/conversations/group-${chatId}`;
  const memberList = allMembers.length > 0
    ? allMembers.map((m) => `- ${m.name}${m.role ? ` (${m.role})` : ""}`).join("\n")
    : "(no members registered yet)";
  const groupHeader =
    `You are a team assistant for a VEX IQ competition group (2026 season). Read CLAUDE.md for behavior.\n` +
    `Team members:\n${memberList}\n` +
    `Each turn's event JSON includes \`from_name\` (the speaker's name) and optionally \`member_role\`. ` +
    `Use these to address them by name and tailor your response.`;
  return PRIMING
    .replace(
      `You are a personal assistant running inside a long-lived daemon process. Read CLAUDE.md and <vault>/persona/USER.md to learn who your human is.`,
      `You are a personal assistant running inside a long-lived daemon process. ${groupHeader}`,
    )
    .replace(/data\/conversations\/YYYY-MM-DD\.md/g, `${groupLogDir}/YYYY-MM-DD.md`);
}

interface TurnResult {
  result: string;       // assistant's final text (from result event)
  sawTgSend: boolean;   // true if any Bash tool_use with bin/tg-send fired this turn
}

interface ClaudeProc {
  proc: Subprocess<"pipe", "pipe", "pipe">;
  enqueue: (text: string) => Promise<TurnResult>;
  shutdown: () => Promise<void>;
  isDead: () => boolean;
  getTurns: () => number;
  getLastCacheRead: () => number;
  spawnedAt: number;
}

const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000; // 30 min

interface PoolEntry {
  proc: ClaudeProc;
  priming: string;   // stored so exit handler can re-send on respawn
  channelType: "dm" | "group";
  inactivityTimer: ReturnType<typeof setTimeout>;
}

const subprocessPool = new Map<number, PoolEntry>();

// Rotate the inner claude before context grows unbounded — context is held in
// RAM as KV cache, and macOS will SIGKILL it under memory pressure (we got
// burned at 2.7M cached tokens). Whichever fires first.
const MAX_TURNS = 50;
const MAX_AGE_MS = 8 * 60 * 60 * 1000;
// Cost-driven backstop: if accumulated context (cache_read) exceeds this AND
// we've completed a few turns, rotate. The 5-turn floor avoids same-turn
// loops on photo/PDF Reads (a single 200K image would otherwise trigger
// rotation on the very turn that needed it).
const MAX_CACHE_READ = 600_000;
const MIN_TURNS_FOR_CACHE_ROTATION = 5;

// Rate-limit notification de-dup state. Each 5-hour or monthly window has a
// unique `resetsAt` (unix seconds); we send at most one warning + one
// rejection per window so we don't spam the user.
let lastWarningResetsAt = 0;
let lastRejectionResetsAt = 0;
const WARNING_UTILIZATION_THRESHOLD = 0.9;

function formatResetTime(resetsAtSec: number): string {
  // 24-hour ET per the user's preferred time format (see USER.md).
  try {
    return new Date(resetsAtSec * 1000).toLocaleTimeString("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return new Date(resetsAtSec * 1000).toISOString();
  }
}

async function notifyRateLimitWarning(utilization: number, resetsAtSec: number) {
  if (resetsAtSec <= lastWarningResetsAt) return; // already warned for this window
  lastWarningResetsAt = resetsAtSec;
  log(`rate-limit warning: utilization=${(utilization * 100).toFixed(0)}% resetsAt=${new Date(resetsAtSec * 1000).toISOString()}`);
  try {
    const adminId = adminMember()?.telegram_chat_id;
    if (!adminId) return;
    await sendMessage(
      adminId,
      `🐉 我快用完这个 5 小时窗口的 token 配额了（${Math.round(utilization * 100)}%）。${formatResetTime(resetsAtSec)} ET 之前可能慢点回复，但还在哦～`,
    );
  } catch (e) { log("warning notify failed:", (e as Error).message); }
}

async function notifyRateLimitRejected(resetsAtSec: number) {
  if (resetsAtSec <= lastRejectionResetsAt) return; // already notified for this window
  lastRejectionResetsAt = resetsAtSec;
  log(`rate-limit REJECTED, resetsAt=${new Date(resetsAtSec * 1000).toISOString()}`);
  try {
    const adminId = adminMember()?.telegram_chat_id;
    if (!adminId) return;
    await sendMessage(
      adminId,
      `⏸ 我刚刚 token 用完了，要等 ${formatResetTime(resetsAtSec)} ET 配额刷新才能继续帮你。先休息一下哦～ 💤`,
    );
  } catch (e) { log("rejected notify failed:", (e as Error).message); }
}

// Two-phase timeout: thinking (no output yet) gets a tight cap to catch hung
// loops fast; once claude starts producing output we extend to a generous
// total so long but actively-streaming turns don't get murdered.
// Idle timer: kill if no claude events arrive within this window. Resets on
// every event (assistant text/tool_use, tool_result, system/init, etc).
// Replaces the old "first response" timer — active multi-tool turns stay
// alive as long as events keep coming.
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const TOTAL_TIMEOUT_MS = 15 * 60 * 1000;
const TURN_TIMEOUT_ERR = "turn timeout";

// Stale-auth detection. The inner claude is a long-running stream-json
// subprocess; if credentials rotate (or get rewritten) mid-session it can
// hold expired in-memory auth and return this string on every turn until
// killed. Match → kill + respawn, don't echo to Telegram.
const AUTH_ERROR_PATTERN = /Not logged in|Please run \/login/;

function spawnClaude(): ClaudeProc {
  // Refresh .mcp.json from .mcp.local.json + latest probe cache. Cheap
  // (single file read+write), happens once per spawn.
  writeMcpConfig();
  log("spawning claude subprocess");
  // Strip Claude Code session vars so the spawned `claude -p` doesn't
  // refuse to start as a nested session when this daemon was launched
  // from inside a Claude Code REPL.
  const childEnv = { ...process.env };
  for (const k of Object.keys(childEnv)) {
    if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) delete childEnv[k];
  }
  const proc = Bun.spawn(
    ["claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions"],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: childEnv },
  );

  // Drain stderr to log; we don't gate on it.
  (async () => {
    const reader = proc.stderr.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const s = dec.decode(value).trim();
      if (s) log("claude.stderr:", s);
    }
  })();

  // Each enqueue resolves when we see the matching `result` event.
  // Single-flight: serialize via a chained promise.
  let chain: Promise<void> = Promise.resolve();
  let pendingResolve: ((r: TurnResult) => void) | null = null;
  // Called by the event reader on every claude event to reset the idle
  // timer. Set per-turn in enqueue(); cleared after the turn settles.
  let resetIdleTimer: (() => void) | null = null;
  // Most recent turn's accumulated context size (cache_read_input_tokens).
  // Used by rotateIfNeeded() as a cost-driven backstop alongside MAX_TURNS/MAX_AGE.
  let lastCacheRead = 0;
  // Per-turn state for auto-send. Reset on each enqueue (at turn start).
  // sawTgSendThisTurn flips true when the model invokes Bash with a command
  // containing "bin/tg-send" (covers tg-send.ts, tg-send-photo.ts, and
  // tg-send-doc.ts). If it stays false AND we have text to send, the
  // daemon auto-sends.
  let sawTgSendThisTurn = false;
  let lastResultText = "";
  // lastAssistantText is the most recent non-empty text block from any
  // assistant event this turn. Fallback for when the model intended its
  // tg-send to be the reply but the call failed (quoting / typo) and the
  // result event came back with empty `result` — we'd otherwise have
  // nothing to auto-send. Updated continuously; final value wins.
  let lastAssistantText = "";
  const enc = new TextEncoder();

  // Read stdout NDJSON forever, signal turn completion.
  (async () => {
    const reader = proc.stdout.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        // Refresh heartbeat on every claude event — a long but actively
        // progressing turn (multi-tool research, etc.) keeps the watchdog
        // satisfied. Only true silence means stuck.
        try { writeFileSync(HEARTBEAT_FILE, new Date().toISOString()); } catch {}
        // Reset idle timeout: any event from claude means the turn is alive.
        resetIdleTimer?.();
        log("claude:", line);
        let ev: {
          type?: string;
          subtype?: string;
          result?: unknown;
          session_id?: string;
          usage?: { cache_read_input_tokens?: number };
        };
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.type === "system" && ev.subtype === "init" && ev.session_id) {
          try {
            registerSession(ev.session_id, "tg");
          } catch (e) {
            log("registerSession failed:", (e as Error).message);
          }
          // Capture per-server MCP statuses for next .mcp.json filtering.
          const mcpServers = (ev as { mcp_servers?: Array<{ name?: string; status?: string }> }).mcp_servers;
          if (Array.isArray(mcpServers)) {
            updateMcpStatuses(mcpServers);
          }
        }
        // Graceful rate-limit messaging: warn the user preemptively when utilization
        // crosses 90% and again when a request actually gets rejected. Once per
        // window (de-duped by resetsAt).
        if (ev.type === "rate_limit_event") {
          const info = (ev as { rate_limit_info?: { status?: string; utilization?: number; resetsAt?: number } }).rate_limit_info;
          if (info && typeof info.resetsAt === "number") {
            if (info.status === "allowed_warning" && (info.utilization ?? 0) >= WARNING_UTILIZATION_THRESHOLD) {
              notifyRateLimitWarning(info.utilization ?? 0, info.resetsAt);
            } else if (info.status === "rejected") {
              notifyRateLimitRejected(info.resetsAt);
            }
          }
        }
        if (ev.type === "assistant") {
          // Scan this assistant message's content for (a) Bash tool_use that
          // invokes bin/tg-send* (suppresses auto-send), and (b) text blocks
          // that we'll fall back to if the result event comes back empty.
          const content = (ev as { message?: { content?: unknown } }).message?.content;
          if (Array.isArray(content)) {
            for (const c of content as Array<{ type?: string; name?: string; input?: { command?: string }; text?: string }>) {
              if (c?.type === "tool_use" && c?.name === "Bash") {
                const cmd = c.input?.command ?? "";
                if (cmd.includes("bin/tg-send")) sawTgSendThisTurn = true;
              }
              if (c?.type === "text" && typeof c.text === "string" && c.text.trim()) {
                lastAssistantText = c.text;
              }
            }
          }
        }
        if (ev.type === "result") {
          if (typeof ev.usage?.cache_read_input_tokens === "number") {
            lastCacheRead = ev.usage.cache_read_input_tokens;
          }
          if (typeof (ev as { result?: unknown }).result === "string") {
            lastResultText = (ev as { result: string }).result;
          }
          // Fallback: if result is empty (model expected its tg-send to BE
          // the reply, e.g. quoting failure swallowed the message) AND we
          // captured an assistant text block earlier, use that instead.
          // Better an over-eager auto-send than a silent drop.
          const finalText = lastResultText.trim() ? lastResultText : lastAssistantText;
          const r = pendingResolve;
          pendingResolve = null;
          if (r) r({ result: finalText, sawTgSend: sawTgSendThisTurn });
        }
      }
    }
    log("claude stdout closed");
  })();

  let dead = false;
  let turns = 0;
  proc.exited.then((code) => {
    log("claude exited code=", code);
    dead = true;
  });

  function enqueue(text: string): Promise<TurnResult> {
    turns++;
    const turn = chain.then(
      () =>
        new Promise<TurnResult>((resolve, reject) => {
          // Reset per-turn state at the actual turn start (after prior
          // turn's chain settles), not at enqueue() call time — otherwise
          // queued-up enqueues would all clobber each other's state.
          sawTgSendThisTurn = false;
          lastResultText = "";
          lastAssistantText = "";
          let idleTimer: ReturnType<typeof setTimeout> | undefined;
          let totalTimer: ReturnType<typeof setTimeout> | undefined;
          const cleanup = () => {
            if (idleTimer) { clearTimeout(idleTimer); idleTimer = undefined; }
            if (totalTimer) { clearTimeout(totalTimer); totalTimer = undefined; }
            resetIdleTimer = null;
          };
          pendingResolve = (r) => {
            cleanup();
            resolve(r);
          };
          const fireTimeout = (reason: string) => {
            if (pendingResolve === null) return;
            pendingResolve = null;
            cleanup();
            log(`turn timed out (${reason}), killing claude`);
            try { proc.kill(); } catch {}
            // SIGTERM is sometimes ignored by the claude CLI; escalate to
            // SIGKILL after a grace period so proc.exited fires and the
            // auto-respawn handler can replace the zombie.
            setTimeout(() => {
              if (proc.exitCode === null) {
                log("claude still alive 5s after SIGTERM, sending SIGKILL");
                try { proc.kill("SIGKILL"); } catch {}
              }
            }, 5000);
            reject(new Error(TURN_TIMEOUT_ERR));
          };
          const armIdle = () => {
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = setTimeout(
              () => fireTimeout("idle 5min — no claude events"),
              IDLE_TIMEOUT_MS,
            );
          };
          resetIdleTimer = armIdle;
          armIdle();
          totalTimer = setTimeout(
            () => fireTimeout("total 15min"),
            TOTAL_TIMEOUT_MS,
          );
          const payload = JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n";
          proc.stdin.write(enc.encode(payload));
        }),
    );
    chain = turn.catch(() => undefined);
    return turn;
  }

  async function shutdown() {
    log("closing claude stdin");
    try {
      proc.stdin.end();
    } catch {}
    await Promise.race([proc.exited, Bun.sleep(5000)]);
    if (proc.exitCode === null) {
      log("claude did not exit, killing");
      proc.kill();
    }
  }

  return {
    proc,
    enqueue,
    shutdown,
    isDead: () => dead,
    getTurns: () => turns,
    getLastCacheRead: () => lastCacheRead,
    spawnedAt: Date.now(),
  };
}

// ---- Offset persistence ---------------------------------------------------

let offset = 0;
try {
  offset = (await Bun.file(OFFSET_FILE).json()).offset ?? 0;
} catch {}

async function saveOffset() {
  await Bun.write(OFFSET_FILE, JSON.stringify({ offset }));
}

// ---- Subprocess pool management -------------------------------------------

function startInactivityTimer(chatId: number): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    const entry = subprocessPool.get(chatId);
    if (!entry) return;
    log(`chat ${chatId}: inactivity timeout, shutting down subprocess`);
    subprocessPool.delete(chatId);
    entry.proc.shutdown().catch((e) => log("inactivity shutdown error:", (e as Error).message));
  }, INACTIVITY_TIMEOUT_MS);
}

function resetInactivityTimer(chatId: number): void {
  const entry = subprocessPool.get(chatId);
  if (!entry) return;
  clearTimeout(entry.inactivityTimer);
  entry.inactivityTimer = startInactivityTimer(chatId);
}

function buildPriming(chatId: number, channelType: "dm" | "group"): string {
  if (channelType === "dm") {
    const member = getMemberByChatId(members, chatId);
    if (!member) return buildDmPriming({ telegram_chat_id: chatId } as Member, groupChatId);
    return buildDmPriming(member, groupChatId);
  }
  return buildGroupPriming(members, chatId);
}

function attachPoolExitHandler(chatId: number): void {
  const entry = subprocessPool.get(chatId);
  if (!entry) return;
  const { proc, channelType } = entry;
  proc.proc.exited.then(async () => {
    const currentEntry = subprocessPool.get(chatId);
    if (!currentEntry || currentEntry.proc !== proc) return;
    log(`chat ${chatId}: proc exited, auto-respawning`);
    const newProc = spawnClaude();
    const newTimer = startInactivityTimer(chatId);
    const newPriming = buildPriming(chatId, channelType);
    subprocessPool.set(chatId, { proc: newProc, priming: newPriming, channelType, inactivityTimer: newTimer });
    attachPoolExitHandler(chatId);
    try {
      await newProc.enqueue(newPriming);
    } catch (e) {
      log(`chat ${chatId}: auto-respawn priming failed:`, (e as Error).message);
    }
  });
}

async function ensureProc(chatId: number, channelType: "dm" | "group"): Promise<PoolEntry | null> {
  if (channelType === "dm" && !getMemberByChatId(members, chatId)) {
    log(`chat ${chatId}: DM chatId not found in member registry, skipping spawn`);
    return null;
  }

  const priming = buildPriming(chatId, channelType);
  const entry = subprocessPool.get(chatId);

  if (!entry || entry.proc.isDead()) {
    if (entry) clearTimeout(entry.inactivityTimer);
    const proc = spawnClaude();
    const timer = startInactivityTimer(chatId);
    const newEntry: PoolEntry = { proc, priming, channelType, inactivityTimer: timer };
    subprocessPool.set(chatId, newEntry);
    attachPoolExitHandler(chatId);
    await proc.enqueue(priming);
    return newEntry;
  }

  const { proc } = entry;
  const tooOld = Date.now() - proc.spawnedAt > MAX_AGE_MS;
  const tooMany = proc.getTurns() >= MAX_TURNS;
  const tooBig =
    proc.getTurns() >= MIN_TURNS_FOR_CACHE_ROTATION &&
    proc.getLastCacheRead() > MAX_CACHE_READ;

  if (tooOld || tooMany || tooBig) {
    log(`chat ${chatId}: rotating proc (turns=${proc.getTurns()} age=${Date.now() - proc.spawnedAt}ms cache=${proc.getLastCacheRead()})`);
    try {
      await Promise.race([
        proc.enqueue("Pre-rotation flush: persist any in-flight working state to disk now (data/scratchpad.md updates, pending notes). Reply 'flushed' when done. No tg-send for this turn."),
        new Promise<never>((_, rj) => setTimeout(() => rj(new Error("flush timeout")), 30_000)),
      ]);
    } catch (e) {
      log(`chat ${chatId}: pre-rotation flush failed (proceeding):`, (e as Error).message);
    }
    const oldProc = proc;
    const newProc = spawnClaude();
    const newTimer = startInactivityTimer(chatId);
    const newEntry: PoolEntry = { proc: newProc, priming, channelType, inactivityTimer: newTimer };
    subprocessPool.set(chatId, newEntry);
    attachPoolExitHandler(chatId);
    await newProc.enqueue(priming);
    oldProc.shutdown().catch((e) => log(`chat ${chatId}: old proc shutdown error:`, (e as Error).message));
    return newEntry;
  }

  resetInactivityTimer(chatId);
  return entry;
}

// ---- Main loop ------------------------------------------------------------

// ---- Conversation log: external-write detection ---------------------------

// Track the file size daemon has "accounted for" per date. Anything that
// appeared between (last accounted-for size) and (current size at start of
// next event) was written by another process — typically a cron task.
const lastSeenLogSizes: Record<string, number> = {};

function todayChannelLog(
  chatId: number,
  channelType: "dm" | "group",
): { date: string; path: string } {
  const { date } = userDateAndHm();
  const dir = `data/conversations/${channelType}-${chatId}`;
  return { date, path: `${dir}/${date}.md` };
}

function currentLogSize(path: string): number {
  try { return statSync(path).size; } catch { return 0; }
}

// Read newly-appended bytes since last seen. Returns null if no growth or
// if this is the first time we're seeing the date (baseline). Updates
// lastSeenLogSizes to the current size before returning.
function readExternalWritesSinceLastTurn(
  chatId: number,
  channelType: "dm" | "group",
): string | null {
  const { path } = todayChannelLog(chatId, channelType);
  const size = currentLogSize(path);
  const last = lastSeenLogSizes[path];
  if (last === undefined) {
    lastSeenLogSizes[path] = size;
    return null;
  }
  if (size <= last) return null;
  let chunk: string;
  try {
    const buf = readFileSync(path);
    chunk = buf.subarray(last).toString("utf-8");
  } catch {
    lastSeenLogSizes[path] = size;
    return null;
  }
  lastSeenLogSizes[path] = size;
  if (chunk.length > MAX_EXTERNAL_WRITES_BYTES) {
    return chunk.slice(0, MAX_EXTERNAL_WRITES_BYTES) +
      `\n…[TRUNCATED ${chunk.length - MAX_EXTERNAL_WRITES_BYTES} bytes — Read the file for the rest]`;
  }
  return chunk || null;
}

// Mark current log size as fully consumed. Call after claude finishes a
// turn so its own writes (incoming + outgoing logging) don't get re-flagged
// as external on the next turn.
function noteLogConsumed(chatId: number, channelType: "dm" | "group"): void {
  const { path } = todayChannelLog(chatId, channelType);
  lastSeenLogSizes[path] = currentLogSize(path);
}

// Extract the list of currently-active thread slugs from data/scratchpad.md.
// Injected per-turn so the model sees which discussions are open without
// having to re-read the whole file. Returns [] on any read/parse failure —
// never throws, never blocks daemon.
function readActiveThreadSlugs(): string[] {
  try {
    const content = readFileSync("data/scratchpad.md", "utf8");
    const activeStart = content.search(/^## Active\s*$/m);
    if (activeStart < 0) return [];
    // End of Active = next "## " heading, or EOF
    const rest = content.slice(activeStart + "## Active".length);
    const nextSection = rest.search(/^## /m);
    const activeBody = nextSection < 0 ? rest : rest.slice(0, nextSection);
    const slugs: string[] = [];
    for (const m of activeBody.matchAll(/^### thread:\s*(.+)$/gm)) {
      slugs.push(m[1].trim());
    }
    return slugs;
  } catch {
    return [];
  }
}

// ---- Attachment + media-group helpers -------------------------------------

interface PendingAttachment { kind: string; path: string; name?: string; mime?: string }

async function downloadAttachment(m: TelegramMessage): Promise<PendingAttachment | undefined> {
  const hasPhoto = !!(m.photo && m.photo.length > 0);
  const hasDoc = !!m.document;
  const hasSticker = !!m.sticker;
  if (!hasPhoto && !hasDoc && !hasSticker) return undefined;
  if (!existsSync("data/attachments")) mkdirSync("data/attachments", { recursive: true });
  if (hasPhoto) {
    const largest = m.photo![m.photo!.length - 1];
    const path = `data/attachments/${m.message_id}.jpg`;
    try { await downloadFile(largest.file_id, path); return { kind: "photo", path }; }
    catch (err) { log("photo download failed:", (err as Error).message); }
  } else if (hasDoc) {
    const doc = m.document!;
    const name = doc.file_name ?? `${m.message_id}`;
    const path = `data/attachments/${m.message_id}-${name}`;
    try { await downloadFile(doc.file_id, path); return { kind: "document", path, name, mime: doc.mime_type }; }
    catch (err) { log("document download failed:", (err as Error).message); }
  } else if (hasSticker) {
    const s = m.sticker!;
    const ext = s.is_video ? "webm" : s.is_animated ? "tgs" : "webp";
    const path = `data/attachments/${m.message_id}.${ext}`;
    try { await downloadFile(s.file_id, path); return { kind: "sticker", path, name: s.emoji }; }
    catch (err) { log("sticker download failed:", (err as Error).message); }
  }
  return undefined;
}

// Short-circuit handler for `/stats` — runs daemon-stats.ts and replies
// directly, bypassing the inner claude (saves an LLM turn).
async function handleStatsCommand(chatId: number): Promise<void> {
  const proc = Bun.spawn(["bun", "run", "bin/daemon-stats.ts"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  const body = out.trim() || "(no output)";
  // Wrap in triple-backticks so the markdown→HTML converter in lib/telegram
  // renders this as a <pre><code> block (monospaced, lines preserved).
  await sendMessage(chatId, "```\n" + body + "\n```");
  // Log both halves so the conversation file stays consistent.
  const { date, hm } = userDateAndHm();
  const logPath = `data/conversations/${date}.md`;
  if (!existsSync("data/conversations")) mkdirSync("data/conversations", { recursive: true });
  appendFileSync(
    logPath,
    `\n[${hm}] user: /stats\n[${hm}] bot: ${body.replace(/\n/g, " | ")}\n`,
  );
  // Reset baseline so the inner claude doesn't see our writes as "external"
  // on its next turn.
  noteLogConsumed();
}

async function dispatch(m: TelegramMessage, attachments: PendingAttachment[]): Promise<void> {
  await rotateIfNeeded();
  // Short-circuit `/stats` (and only `/stats` — no args, no attachments) to
  // avoid burning an inner-claude turn on a deterministic readout.
  if ((m.text ?? "").trim() === "/stats" && attachments.length === 0) {
    log("dispatch: /stats short-circuit");
    await handleStatsCommand(m.chat.id);
    return;
  }
  let replyTo;
  if (m.reply_to_message) {
    const r = m.reply_to_message;
    const kind = r.photo?.length ? "photo" : r.document ? "document" : r.sticker ? "sticker" : undefined;
    replyTo = {
      message_id: r.message_id,
      from_bot: r.from?.is_bot === true,
      text: r.text || r.caption || (kind ? `[${kind}]` : ""),
      attachment_kind: kind,
      attachment_name: r.document?.file_name,
    };
  }
  const first = attachments[0];
  const placeholder = first
    ? `[${first.kind}${attachments.length > 1 ? ` x${attachments.length}` : ""}]`
    : "";
  const event: Record<string, unknown> = {
    chat_id: m.chat.id,
    from: m.from
      ? `${m.from.first_name}${m.from.username ? ` (@${m.from.username})` : ""}`
      : "unknown",
    text: m.text || m.caption || placeholder,
    reply_to: replyTo,
    date: new Date(m.date * 1000).toISOString(),
    message_id: m.message_id,
  };
  if (attachments.length === 1) event.attachment = attachments[0];
  else if (attachments.length > 1) event.attachments = attachments;
  const externalWrites = readExternalWritesSinceLastTurn();
  if (externalWrites) event.external_writes_since_last_turn = externalWrites;
  const activeThreads = readActiveThreadSlugs();
  if (activeThreads.length > 0) event.active_threads = activeThreads;
  log("-> telegram event", event);
  sendTyping(m.chat.id).catch(() => {});
  const typingTimer = setInterval(() => { sendTyping(m.chat.id).catch(() => {}); }, 4000);
  try {
    const turnResult = await claude.enqueue(`[Telegram event] ${JSON.stringify(event)}`);
    if (AUTH_ERROR_PATTERN.test(turnResult.result)) {
      log("auth failure detected in result, killing subprocess to force respawn");
      sendMessage(m.chat.id, "🚨 我的身份验证过期了，正在重启子进程。几秒后再发一次就行～")
        .catch((e) => log("auth-alert send failed:", (e as Error).message));
      try { claude.proc.kill(); } catch {}
      // attachExitHandler spawns a fresh subprocess that reads current creds.
      return;
    }
    // Auto-send the model's final text if it didn't already call tg-send
    // (or tg-send-photo) during the turn. This is the default reply path —
    // the model only needs to call tg-send.ts explicitly for split messages,
    // photos, or pre-tool messages. Aligns with the model's natural prior
    // ("what I write is what the user sees") instead of fighting it.
    if (!turnResult.sawTgSend && turnResult.result.trim()) {
      try {
        await sendMessage(m.chat.id, turnResult.result);
        // Daemon owns the bot-line log entry too in this case, since the
        // model didn't go through its usual reply path. We don't write the
        // user line — the model handles that on first turn per SKILL.md.
        const { date, hm } = userDateAndHm();
        const logPath = `data/conversations/${date}.md`;
        if (!existsSync("data/conversations")) mkdirSync("data/conversations", { recursive: true });
        appendFileSync(
          logPath,
          `[${hm}] bot: ${turnResult.result.replace(/\n/g, " | ")}\n`,
        );
      } catch (e) {
        log("auto-send failed:", (e as Error).message);
      }
    }
    // After claude's turn (incl. its own log writes), reset baseline so its
    // writes don't get re-flagged as external on the next turn.
    noteLogConsumed();
  } catch (err) {
    const e = err as Error;
    log("enqueue failed:", e.message);
    if (e.message === TURN_TIMEOUT_ERR) {
      sendMessage(m.chat.id, "我处理这条消息卡住了 😔 重发一遍或者换个说法试试？")
        .catch((se) => log("apology send failed:", (se as Error).message));
    }
  } finally {
    clearInterval(typingTimer);
  }
}

// Telegram delivers media groups (multi-photo sends) as N separate Updates
// sharing media_group_id. Buffer them so the inner claude sees one turn
// with all attachments instead of N single-photo turns.
const MEDIA_GROUP_DEBOUNCE_MS = 800;
interface MediaGroupBuf {
  first: TelegramMessage;
  attachments: PendingAttachment[];
  timer: ReturnType<typeof setTimeout>;
}
const mediaGroups = new Map<string, MediaGroupBuf>();

function bufferMediaGroup(m: TelegramMessage, att: PendingAttachment | undefined) {
  const key = `${m.chat.id}:${m.media_group_id}`;
  const existing = mediaGroups.get(key);
  if (existing) {
    if (att) existing.attachments.push(att);
    // Telegram puts the caption on whichever message the user wrote it on
    // (usually the first); preserve any caption we see on the buffer's `first`.
    if (!existing.first.caption && !existing.first.text && (m.caption || m.text)) {
      existing.first = { ...existing.first, caption: m.caption ?? existing.first.caption, text: m.text ?? existing.first.text };
    }
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => fireMediaGroup(key), MEDIA_GROUP_DEBOUNCE_MS);
    return;
  }
  const buf: MediaGroupBuf = {
    first: m,
    attachments: att ? [att] : [],
    timer: setTimeout(() => fireMediaGroup(key), MEDIA_GROUP_DEBOUNCE_MS),
  };
  mediaGroups.set(key, buf);
}

function fireMediaGroup(key: string) {
  const buf = mediaGroups.get(key);
  if (!buf) return;
  mediaGroups.delete(key);
  log(`media group ${key} firing with ${buf.attachments.length} attachment(s)`);
  dispatch(buf.first, buf.attachments).catch((e) => log("media group dispatch error:", (e as Error).message));
}

let stopping = false;
const stop = async (sig: string) => {
  if (stopping) return;
  stopping = true;
  log("received", sig, "shutting down");
  const shutdowns = [...subprocessPool.values()].map((entry) => {
    clearTimeout(entry.inactivityTimer);
    return entry.proc.shutdown();
  });
  await Promise.allSettled(shutdowns);
  subprocessPool.clear();
  await saveOffset();
  process.exit(0);
};
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

while (!stopping) {
  // Stamp heartbeat at the top of each iteration. If getUpdates hangs, or
  // dispatch (downloadAttachment / inner-claude turn) hangs, this file
  // stops aging — watchdog uses staleness to detect a wedged loop and
  // silently respawn us.
  try { writeFileSync(HEARTBEAT_FILE, new Date().toISOString()); } catch {}

  let updates;
  try {
    updates = await getUpdates(offset, LONG_POLL_TIMEOUT);
  } catch (err) {
    log("getUpdates error:", (err as Error).message);
    await Bun.sleep(2000);
    continue;
  }

  for (const u of updates) {
    if (stopping) break;
    const m = u.message;

    // Skip non-message updates, unauthorized chats, and content-less messages.
    // We still advance the offset for these so unauthorized senders / edited
    // messages / etc. can't backlog us.
    if (!m) { offset = u.update_id + 1; await saveOffset(); continue; }
    // Reject messages from unknown chats/users.
    const channelType = m.chat.type === "private" ? "dm" : "group";
    if (channelType === "dm") {
      if (!getMemberByChatId(members, m.chat.id)) {
        log("rejected: unknown DM chat_id", m.chat.id);
        offset = u.update_id + 1; await saveOffset(); continue;
      }
    } else {
      // For group messages, track the group chat_id and check the sender.
      groupChatId = m.chat.id;
      if (m.from?.id && !getMemberByUserId(members, m.from.id)) {
        log("rejected: unknown user_id in group", m.from?.id);
        offset = u.update_id + 1; await saveOffset(); continue;
      }
    }
    const hasPhoto = !!(m.photo && m.photo.length > 0);
    const hasDoc = !!m.document;
    const hasSticker = !!m.sticker;
    if (!m.text && !hasPhoto && !hasDoc && !hasSticker) {
      offset = u.update_id + 1; await saveOffset(); continue;
    }

    const att = await downloadAttachment(m);

    if (m.media_group_id) {
      bufferMediaGroup(m, att);
      // Show typing now; the eventual dispatch will refresh it. The group
      // arrives within ms, fires ~800ms later — well within typing TTL.
      sendTyping(m.chat.id).catch(() => {});
      // Advance offset on buffer (not on dispatch). Accepts a small loss
      // window if killed during the 800ms debounce; keeps the loop moving.
      offset = u.update_id + 1; await saveOffset();
      continue;
    }

    await dispatch(m, att ? [att] : []);
    // Only advance offset AFTER successful dispatch. If killed mid-dispatch
    // (or before it), the next daemon re-fetches this message from Telegram.
    offset = u.update_id + 1;
    await saveOffset();
  }
}
