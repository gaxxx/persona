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

const OFFSET_FILE = "data/tg-offset.json";
const LOG_FILE = "data/daemon.log";
const HEARTBEAT_FILE = "data/tg-daemon-heartbeat";
const LONG_POLL_TIMEOUT = 25;
// Cap external-writes payload to keep event JSON sane. If an unusually huge
// cron output appears between turns, the payload gets truncated and claude
// can re-read the file if needed (the truncated marker is unmistakable).
const MAX_EXTERNAL_WRITES_BYTES = 4096;

// Allowlist: only accept messages from these chat IDs. Set TELEGRAM_CHAT_ID
// (single id) or TELEGRAM_CHAT_IDS (comma-separated). Empty = reject everything.
const ALLOWED_CHAT_IDS = new Set(
  (process.env.TELEGRAM_CHAT_IDS ?? process.env.TELEGRAM_CHAT_ID ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number),
);
if (ALLOWED_CHAT_IDS.size === 0) {
  console.error("FATAL: TELEGRAM_CHAT_ID (or TELEGRAM_CHAT_IDS) is not set. Refusing to start without a chat allowlist.");
  process.exit(1);
}

if (!existsSync("data")) mkdirSync("data", { recursive: true });

function log(...parts: unknown[]) {
  const line = `[${new Date().toISOString()}] ${parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ")}\n`;
  appendFileSync(LOG_FILE, line);
  process.stdout.write(line);
}

// ---- Claude subprocess ----------------------------------------------------

const PRIMING = `You are a personal assistant running inside a long-lived daemon process. Read CLAUDE.md and <vault>/persona/USER.md to learn who your human is.

Each user turn I send you is one Telegram event in this exact form:
  [Telegram event] {"chat_id":..., "from":"...", "text":"...", "attachment":{kind,path,name?,mime?}|undefined, "date":"...", "message_id":...}

If \`attachment\` is set, the user attached a single file. \`kind\` is "photo" / "document" / "sticker". \`path\` is a relative path under data/attachments/. Read it with the Read tool - Read supports images and PDFs natively. Stickers may be webp/tgs/webm; for tgs/webm just acknowledge the sticker (use \`name\` if it's an emoji). \`text\` is caption or a placeholder if none.

If \`attachments\` (plural array) is set instead, the user sent multiple files at once as a Telegram media group (e.g. 2-10 photos in a single send). Each entry has the same shape as \`attachment\`. Read all of them with the Read tool and treat them as one user turn — the caption (if any) is in \`text\` and applies to the whole group.

When you reply to a photo/document, include enough description in your reply that a future session reading the conversation log can understand what the file was about WITHOUT having to re-Read it. e.g. don't just say "好看!" — say "好看! 这盘麻婆豆腐看起来很正宗". The actual image/PDF bytes are NOT in the conversation log (only your text reply is), so your reply is the future-you's only handle to that attachment unless they re-Read it from \`data/attachments/<message_id>.*\`.

If \`reply_to\` is set, the user is replying to an earlier message. Use it as context for what they're responding to. If \`reply_to.from_bot\` is true, that prior message was from you - find it in data/conversations/YYYY-MM-DD.md to recover full context. If the replied-to had an attachment that was previously processed by this daemon, the file is at data/attachments/<reply_to.message_id>.* - Read it if relevant.

Read CLAUDE.md (in cwd) for behaviour. Use the assistant-loop skill mechanics:
read identity/user/conversation context, route to skills/MCP tools, reply via
\`bun run bin/tg-send.ts <chat_id> "<msg>"\`, log to data/conversations/YYYY-MM-DD.md.

Conversation log timestamps MUST be in the user's wall-clock time (per USER.md \`Timezone\`), NOT UTC. The filename's YYYY-MM-DD and the \`[HH:MM]\` prefix on each line should both reflect the user's local day. Get a correct timestamp by running \`bun run bin/lib/user-tz.ts\` (prints \`YYYY-MM-DD HH:MM <tz>\`) — never construct from \`new Date().toISOString()\`, which is UTC and rolls past midnight ~5 hours before her wall clock does.

Conversation log loading discipline (overrides the skill's "always load" step):
- FIRST turn after spawn: read today's conversation log as the skill requires.
- SUBSEQUENT turns: do NOT re-read the full log by default — your in-context memory of prior turns covers it. Re-read only when one of:
  (a) the user references past events ("yesterday" / "earlier" / "我之前说过" / "上次" / etc),
  (b) \`reply_to.from_bot=true\` (find the original message),
  (c) the event JSON contains an \`external_writes_since_last_turn\` field — those lines were written by other processes (typically cron tasks) since your last turn. Treat them as already-read context. The field's content is the raw appended text from the conversation log; you don't need to Read the file to find it. If it ends with a "[TRUNCATED N bytes …]" marker, then Read the file to get the rest.
- TRIVIAL messages (pure greetings like "你好" / "thanks" / "👍", or questions answerable from USER.md alone like "我在哪个时区"): skip reading the log entirely, even on the first turn — answer directly and call tg-send.

Do NOT start a Monitor or any watcher - the daemon owns Telegram polling.
Do NOT call tg-pull.ts.

CRITICAL: Every reply to the user MUST be sent via \`bun run bin/tg-send.ts <chat_id> "<msg>"\`. Never return the answer as result text without calling tg-send first — the result field is not visible to the user.

Acknowledge with the single word READY.`;

interface ClaudeProc {
  proc: Subprocess<"pipe", "pipe", "pipe">;
  enqueue: (text: string) => Promise<void>;
  shutdown: () => Promise<void>;
  isDead: () => boolean;
  getTurns: () => number;
  getLastCacheRead: () => number;
  spawnedAt: number;
}

// Rotate the inner claude before context grows unbounded — context is held in
// RAM as KV cache, and macOS will SIGKILL it under memory pressure (we got
// burned at 2.7M cached tokens). Whichever fires first.
const MAX_TURNS = 25;
const MAX_AGE_MS = 4 * 60 * 60 * 1000;
// Cost-driven backstop: if accumulated context (cache_read) exceeds this AND
// we've completed a few turns, rotate. The 5-turn floor avoids same-turn
// loops on photo/PDF Reads (a single 200K image would otherwise trigger
// rotation on the very turn that needed it).
const MAX_CACHE_READ = 500_000;
const MIN_TURNS_FOR_CACHE_ROTATION = 5;
// Two-phase timeout: thinking (no output yet) gets a tight cap to catch hung
// loops fast; once claude starts producing output we extend to a generous
// total so long but actively-streaming turns don't get murdered.
const FIRST_RESPONSE_TIMEOUT_MS = 2 * 60 * 1000;
const TOTAL_TIMEOUT_MS = 15 * 60 * 1000;
const TURN_TIMEOUT_ERR = "turn timeout";

function spawnClaude(): ClaudeProc {
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
  let pendingResolve: (() => void) | null = null;
  // Fired once per turn the first time claude emits any assistant event
  // (text or tool_use). Used to swap thinking -> typing timeout.
  let onFirstResponse: (() => void) | null = null;
  // Most recent turn's accumulated context size (cache_read_input_tokens).
  // Used by rotateIfNeeded() as a cost-driven backstop alongside MAX_TURNS/MAX_AGE.
  let lastCacheRead = 0;
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
        }
        if (ev.type === "assistant" && onFirstResponse) {
          const cb = onFirstResponse;
          onFirstResponse = null;
          cb();
        }
        if (ev.type === "result") {
          if (typeof ev.usage?.cache_read_input_tokens === "number") {
            lastCacheRead = ev.usage.cache_read_input_tokens;
          }
          const r = pendingResolve;
          pendingResolve = null;
          if (r) r();
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

  function enqueue(text: string): Promise<void> {
    turns++;
    const turn = chain.then(
      () =>
        new Promise<void>((resolve, reject) => {
          let firstResponseTimer: ReturnType<typeof setTimeout> | undefined;
          let totalTimer: ReturnType<typeof setTimeout> | undefined;
          const cleanup = () => {
            if (firstResponseTimer) { clearTimeout(firstResponseTimer); firstResponseTimer = undefined; }
            if (totalTimer) { clearTimeout(totalTimer); totalTimer = undefined; }
            onFirstResponse = null;
          };
          pendingResolve = () => {
            cleanup();
            resolve();
          };
          const fireTimeout = (reason: string) => {
            if (pendingResolve === null) return;
            pendingResolve = null;
            cleanup();
            log(`turn timed out (${reason}), killing claude`);
            try { proc.kill(); } catch {}
            reject(new Error(TURN_TIMEOUT_ERR));
          };
          firstResponseTimer = setTimeout(
            () => fireTimeout("no first response in 2min"),
            FIRST_RESPONSE_TIMEOUT_MS,
          );
          totalTimer = setTimeout(
            () => fireTimeout("total 15min"),
            TOTAL_TIMEOUT_MS,
          );
          onFirstResponse = () => {
            log("first response received, switching to typing phase");
            if (firstResponseTimer) { clearTimeout(firstResponseTimer); firstResponseTimer = undefined; }
          };
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

// ---- Main loop ------------------------------------------------------------

let claude = spawnClaude();
attachExitHandler(claude);
await claude.enqueue(PRIMING);
log("priming complete, entering poll loop");

// If the inner claude dies (e.g. macOS jetsam), respawn proactively instead
// of waiting for the next Telegram event to notice. Guarded by identity check
// so a manual rotation in the main loop doesn't trigger a double-spawn.
function attachExitHandler(c: ClaudeProc) {
  c.proc.exited.then(async () => {
    if (claude !== c) return;
    log("auto-respawning after exit");
    claude = spawnClaude();
    attachExitHandler(claude);
    try {
      await claude.enqueue(PRIMING);
    } catch (e) {
      log("auto-respawn priming failed:", (e as Error).message);
    }
  });
}

async function rotateIfNeeded() {
  // If the proc died, respawn now. We may race with attachExitHandler — that's
  // fine, whichever wins reassigns `claude` and the loser's identity check
  // (`claude !== c`) makes it skip.
  if (claude.isDead()) {
    log("claude is dead, respawning (main loop)");
    claude = spawnClaude();
    attachExitHandler(claude);
    await claude.enqueue(PRIMING);
    return;
  }
  const tooOld = Date.now() - claude.spawnedAt > MAX_AGE_MS;
  const tooMany = claude.getTurns() >= MAX_TURNS;
  const tooBig =
    claude.getTurns() >= MIN_TURNS_FOR_CACHE_ROTATION &&
    claude.getLastCacheRead() > MAX_CACHE_READ;
  if (tooOld || tooMany || tooBig) {
    log(
      `rotating claude: turns=${claude.getTurns()} ageMs=${Date.now() - claude.spawnedAt} cacheRead=${claude.getLastCacheRead()}`,
    );
    const old = claude;
    claude = spawnClaude();
    attachExitHandler(claude);
    await claude.enqueue(PRIMING);
    old.shutdown().catch((e) => log("old claude shutdown error:", (e as Error).message));
  }
}

// ---- Conversation log: external-write detection ---------------------------

// Track the file size daemon has "accounted for" per date. Anything that
// appeared between (last accounted-for size) and (current size at start of
// next event) was written by another process — typically a cron task.
const lastSeenLogSizes: Record<string, number> = {};

function todayLogPath(): { date: string; path: string } {
  const { date } = userDateAndHm();
  return { date, path: `data/conversations/${date}.md` };
}

function currentLogSize(path: string): number {
  try { return statSync(path).size; } catch { return 0; }
}

// Read newly-appended bytes since last seen. Returns null if no growth or
// if this is the first time we're seeing the date (baseline). Updates
// lastSeenLogSizes to the current size before returning.
function readExternalWritesSinceLastTurn(): string | null {
  const { date, path } = todayLogPath();
  const size = currentLogSize(path);
  const last = lastSeenLogSizes[date];
  if (last === undefined) {
    // First check for this date — establish baseline, no diff to report.
    lastSeenLogSizes[date] = size;
    return null;
  }
  if (size <= last) return null;
  let chunk: string;
  try {
    const buf = readFileSync(path);
    chunk = buf.subarray(last).toString("utf-8");
  } catch {
    lastSeenLogSizes[date] = size;
    return null;
  }
  lastSeenLogSizes[date] = size;
  if (chunk.length > MAX_EXTERNAL_WRITES_BYTES) {
    return chunk.slice(0, MAX_EXTERNAL_WRITES_BYTES) + `\n…[TRUNCATED ${chunk.length - MAX_EXTERNAL_WRITES_BYTES} bytes — Read the file for the rest]`;
  }
  return chunk || null;
}

// Mark current log size as fully consumed. Call after claude finishes a
// turn so its own writes (incoming + outgoing logging) don't get re-flagged
// as external on the next turn.
function noteLogConsumed(): void {
  const { date, path } = todayLogPath();
  lastSeenLogSizes[date] = currentLogSize(path);
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
  log("-> telegram event", event);
  sendTyping(m.chat.id).catch(() => {});
  const typingTimer = setInterval(() => { sendTyping(m.chat.id).catch(() => {}); }, 4000);
  try {
    await claude.enqueue(`[Telegram event] ${JSON.stringify(event)}`);
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
  await claude.shutdown();
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
    if (!ALLOWED_CHAT_IDS.has(m.chat.id)) {
      log("rejected: chat_id", m.chat.id, "from", m.from?.username ?? m.from?.first_name ?? "?");
      offset = u.update_id + 1; await saveOffset(); continue;
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
