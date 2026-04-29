#!/usr/bin/env bun
/**
 * Telegram daemon: long-poll Telegram, route each message into a single
 * persistent `claude -p --input-format stream-json --output-format stream-json`
 * subprocess. The subprocess does ALL the work (loads CLAUDE.md, replies via
 * `bun run bin/tg-send.ts`, logs conversations). The daemon is just plumbing.
 *
 * Stream-json envelopes (confirmed by manual probe):
 *   stdin  → {"type":"user","message":{"role":"user","content":"<text>"}}\n
 *   stdout → NDJSON, multiple events per turn. Notable types:
 *              system/init, rate_limit_event, assistant, result/<subtype>
 *            A `{type:"result"}` event marks turn completion. session_id is
 *            preserved across turns within one subprocess.
 *
 * Run:  bun run bin/tg-daemon.ts
 */
import { getUpdates, downloadFile } from "./lib/telegram";
import { mkdirSync, existsSync, appendFileSync } from "fs";
import type { Subprocess } from "bun";

const OFFSET_FILE = "data/tg-offset.json";
const LOG_FILE = "data/daemon.log";
const LONG_POLL_TIMEOUT = 25;

if (!existsSync("data")) mkdirSync("data", { recursive: true });

function log(...parts: unknown[]) {
  const line = `[${new Date().toISOString()}] ${parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ")}\n`;
  appendFileSync(LOG_FILE, line);
  process.stdout.write(line);
}

// ---- Claude subprocess ----------------------------------------------------

const PRIMING = `You are USER's personal assistant running inside a long-lived daemon process.

Each user turn I send you is one Telegram event in this exact form:
  [Telegram event] {"chat_id":..., "from":"...", "text":"...", "attachment":{kind,path,name?,mime?}|undefined, "date":"...", "message_id":...}

If \`attachment\` is set, the user attached a file. \`kind\` is "photo" / "document" / "sticker". \`path\` is a relative path under data/attachments/. Read it with the Read tool — Read supports images and PDFs natively. Stickers may be webp/tgs/webm; for tgs/webm just acknowledge the sticker (use \`name\` if it's an emoji). \`text\` is caption or a placeholder if none.

If \`reply_to\` is set, the user is replying to an earlier message. Use it as context for what they're responding to. If \`reply_to.from_bot\` is true, that prior message was from you — find it in data/conversations/YYYY-MM-DD.md to recover full context. If the replied-to had an attachment that was previously processed by this daemon, the file is at data/attachments/<reply_to.message_id>.* — Read it if relevant.

Read CLAUDE.md (in cwd) for behaviour. Use the assistant-loop skill mechanics:
read identity/user/conversation context, route to skills/MCP tools, reply via
\`bun run bin/tg-send.ts <chat_id> "<msg>"\`, log to data/conversations/YYYY-MM-DD.md.

Do NOT start a Monitor or any watcher — the daemon owns Telegram polling.
Do NOT call tg-pull.ts.

Acknowledge with the single word READY.`;

interface ClaudeProc {
  proc: Subprocess<"pipe", "pipe", "pipe">;
  enqueue: (text: string) => Promise<void>;
  shutdown: () => Promise<void>;
}

function spawnClaude(): ClaudeProc {
  log("spawning claude subprocess");
  const proc = Bun.spawn(
    ["claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions"],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
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
        log("claude:", line);
        let ev: { type?: string; subtype?: string; result?: unknown };
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.type === "result") {
          const r = pendingResolve;
          pendingResolve = null;
          if (r) r();
        }
      }
    }
    log("claude stdout closed");
  })();

  proc.exited.then((code) => log("claude exited code=", code));

  function enqueue(text: string): Promise<void> {
    const turn = chain.then(
      () =>
        new Promise<void>((resolve) => {
          pendingResolve = resolve;
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

  return { proc, enqueue, shutdown };
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
await claude.enqueue(PRIMING);
log("priming complete, entering poll loop");

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
  let updates;
  try {
    updates = await getUpdates(offset, LONG_POLL_TIMEOUT);
  } catch (err) {
    log("getUpdates error:", (err as Error).message);
    await Bun.sleep(2000);
    continue;
  }

  for (const u of updates) {
    offset = u.update_id + 1;
    const m = u.message;
    if (!m) continue;
    const hasPhoto = !!(m.photo && m.photo.length > 0);
    const hasDoc = !!m.document;
    const hasSticker = !!m.sticker;
    if (!m.text && !hasPhoto && !hasDoc && !hasSticker) continue;

    // Restart claude if it died between turns.
    if (claude.proc.exitCode !== null) {
      log("claude is dead, respawning");
      claude = spawnClaude();
      await claude.enqueue(PRIMING);
    }

    let attachment: { kind: string; path: string; name?: string; mime?: string } | undefined;
    if (hasPhoto || hasDoc || hasSticker) {
      if (!existsSync("data/attachments")) mkdirSync("data/attachments", { recursive: true });
    }
    if (hasPhoto) {
      const largest = m.photo![m.photo!.length - 1];
      const path = `data/attachments/${m.message_id}.jpg`;
      try {
        await downloadFile(largest.file_id, path);
        attachment = { kind: "photo", path };
      } catch (err) {
        log("photo download failed:", (err as Error).message);
      }
    } else if (hasDoc) {
      const doc = m.document!;
      const name = doc.file_name ?? `${m.message_id}`;
      const path = `data/attachments/${m.message_id}-${name}`;
      try {
        await downloadFile(doc.file_id, path);
        attachment = { kind: "document", path, name, mime: doc.mime_type };
      } catch (err) {
        log("document download failed:", (err as Error).message);
      }
    } else if (hasSticker) {
      const s = m.sticker!;
      const ext = s.is_video ? "webm" : s.is_animated ? "tgs" : "webp";
      const path = `data/attachments/${m.message_id}.${ext}`;
      try {
        await downloadFile(s.file_id, path);
        attachment = { kind: "sticker", path, name: s.emoji };
      } catch (err) {
        log("sticker download failed:", (err as Error).message);
      }
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

    const event = {
      chat_id: m.chat.id,
      from: m.from
        ? `${m.from.first_name}${m.from.username ? ` (@${m.from.username})` : ""}`
        : "unknown",
      text: m.text || m.caption || (attachment ? `[${attachment.kind}]` : ""),
      attachment,
      reply_to: replyTo,
      date: new Date(m.date * 1000).toISOString(),
      message_id: m.message_id,
    };
    log("→ telegram event", event);
    try {
      await claude.enqueue(`[Telegram event] ${JSON.stringify(event)}`);
    } catch (err) {
      log("enqueue failed:", (err as Error).message);
    }
  }

  if (updates.length > 0) await saveOffset();
}
