/**
 * interactive-backend.ts — a `ClaudeProc` backed by the INTERACTIVE Claude Code
 * TUI (driven over a pty by InteractiveClaude), as an alternate to tg-daemon's
 * default stream-json `spawnClaude()`.
 *
 * Why: as of 2026-06-15 Anthropic meters headless `claude -p` / Agent-SDK usage
 * separately from the flat subscription, while the interactive TUI stays on the
 * flat plan. This backend lets the daemon run on the flat plan. It is OPT-IN:
 * tg-daemon only uses it when TG_BACKEND=interactive. Default behaviour is
 * unchanged. See bin/lib/INTERACTIVE-NOTES.md ("Phase 1 integration").
 *
 * What this adapter maps (stream-json semantics → interactive equivalents):
 *   - enqueue(text)      → InteractiveClaude.send(text); result = scraped reply
 *                          (with the session JSONL's last assistant text as the
 *                          empty-reply fallback).
 *   - sawTgSend          → scan the session JSONL transcript for a Bash tool_use
 *                          whose command contains "bin/tg-send" (the TUI collapses
 *                          tool calls on screen, so a screen scan can't see them —
 *                          see the big comment below). Mirrors the stream-json
 *                          path's detection exactly.
 *   - isDead()           → pty child exited, or an auth screen was detected.
 *   - getTurns()         → count of completed enqueue() calls.
 *   - getLastCacheRead() → always 0 (no usage events in interactive mode), so
 *                          cache-pressure rotation never fires; age/turn-count
 *                          rotation still works.
 *   - spawnedAt          → construction time.
 *   - shutdown()         → close the pty/child cleanly.
 *
 * KNOWN Phase-1 limitations (accepted; documented in INTERACTIVE-NOTES.md):
 *   - Long replies can scroll off the alternate screen buffer and be truncated
 *     in `result` (NOTES #1). Accepted because the persona delivers its own
 *     replies via bin/tg-send.ts; the scraped result is fallback + logging only.
 *   - The sawTgSend scan is best-effort (NOTES #2): tool lines render as `●`
 *     bullets just like prose, and long command lines can be ellipsised.
 */
import { InteractiveClaude } from "./interactive-claude";
import type { ClaudeProc, TurnResult } from "./claude-proc";
import { AUTH_SCREEN_PATTERNS, AUTH_SIGNAL, TG_SEND_RE } from "./tui-strings";
import { readdirSync, statSync, readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---- Session JSONL transcript --------------------------------------------
//
// IMPORTANT deviation from the original task brief: the brief assumed a tg-send
// Bash call would render as a `●`-bulleted command line in the scraped screen,
// so sawTgSend could be detected by scanning the scrape. EMPIRICALLY FALSE — the
// Claude Code v2.1.x TUI COLLAPSES tool calls to "Ran N shell command(s)" and
// does NOT show the command text on screen. Scanning the scrape would therefore
// report sawTgSend≈always-false → the daemon would auto-send the scraped reply
// ON TOP OF the persona's own tg-send.ts message (double-send).
//
// Instead we read the interactive session's JSONL transcript (the same data the
// TUI persists under ~/.claude/projects/<cwd>/<session-id>.jsonl). It records
// the full tool_use events incl. the Bash `command`, so we can detect a
// `bin/tg-send*` invocation the SAME way the stream-json path does (scan
// assistant tool_use for Bash commands containing "bin/tg-send"). This is the
// approach INTERACTIVE-NOTES.md #1/#2 themselves recommend. It is reliable, not
// heuristic — the one residual edge is pinning to the right session file (below).

/** Claude Code encodes a project's transcript dir by replacing every "/" and
 *  "." in the absolute cwd with "-". */
function projectDir(): string {
  return join(homedir(), ".claude", "projects", process.cwd().replace(/[/.]/g, "-"));
}

function log(...parts: unknown[]) {
  // Mirror tg-daemon's log() prefix style so backend lines interleave readably
  // in data/daemon.log (the daemon's own logger also writes there).
  console.error(
    `[${new Date().toISOString()}] [interactive-backend]`,
    ...parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))),
  );
}

export function spawnInteractiveClaude(): ClaudeProc {
  log("spawning interactive claude (pty TUI backend)");

  const ic = new InteractiveClaude({
    debug: process.env.IC_DEBUG === "1",
    // Optional raw pty dump for post-mortem debugging of a stuck session.
    rawDumpPath: process.env.IC_RAW_DUMP || undefined,
  });

  // start() spawns the pty subprocess synchronously (Bun.spawn runs before the
  // first `await` inside start()), so ic.subprocess is populated by the time
  // this un-awaited call returns. We await the boot-completion promise lazily,
  // on the first enqueue, because spawnClaude() (the contract we mirror) is
  // synchronous and the daemon reads `.proc` immediately after calling us.
  let bootError: Error | null = null;
  let booting: Promise<void> | null = ic
    .start()
    .catch((e: unknown) => {
      bootError = e as Error;
      log("boot failed:", (e as Error).message);
    });

  const procMaybe = ic.subprocess;
  if (!procMaybe) {
    // Bun.spawn failed synchronously (rare). Surface loudly; the daemon's
    // top-level spawn site will crash and the watchdog will respawn the daemon.
    throw new Error("interactive-backend: pty subprocess failed to spawn");
  }
  // Bind a non-null const so the narrowing survives into the closures below.
  const proc = procMaybe;

  const spawnedAt = Date.now();
  let turns = 0;
  let authFailed = false;
  let exited = false;
  proc.exited.then(() => {
    exited = true;
    log("pty child exited");
  });

  // Pin to OUR session's JSONL: snapshot the transcript files that exist before
  // we boot, then our session is the first NEW *.jsonl to appear in this cwd's
  // project dir. This survives concurrent claude processes that share the cwd
  // (e.g. a task-runner worker) better than "newest file in dir" would. Residual
  // race: another NEW session in the same cwd starting in the window between our
  // spawn and our first turn could be mis-pinned — vanishingly rare in practice;
  // documented in INTERACTIVE-NOTES.md.
  const dir = projectDir();
  const preexisting = new Set<string>(
    existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".jsonl")) : [],
  );
  let sessionFile: string | null = null;
  function resolveSessionFile(): string | null {
    if (sessionFile && existsSync(sessionFile)) return sessionFile;
    if (!existsSync(dir)) return null;
    let best: { path: string; m: number } | null = null;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".jsonl") || preexisting.has(f)) continue;
      const p = join(dir, f);
      let m: number;
      try { m = statSync(p).mtimeMs; } catch { continue; }
      if (!best || m > best.m) best = { path: p, m };
    }
    if (best) { sessionFile = best.path; log("pinned session transcript:", sessionFile); }
    return sessionFile;
  }
  function sessionSize(): number {
    const f = resolveSessionFile();
    if (!f) return 0;
    try { return statSync(f).size; } catch { return 0; }
  }
  // Scan the JSONL appended during this turn (from `fromOffset`) for (a) a
  // bin/tg-send Bash tool_use and (b) the last assistant text block. Mirrors the
  // stream-json reader in tg-daemon.ts::spawnClaude exactly.
  function readTurnTranscript(fromOffset: number): { sawTgSend: boolean; lastText: string } {
    const f = resolveSessionFile();
    if (!f || !existsSync(f)) return { sawTgSend: false, lastText: "" };
    let buf: Buffer;
    try { buf = readFileSync(f); } catch { return { sawTgSend: false, lastText: "" }; }
    const chunk = buf.subarray(Math.min(fromOffset, buf.length)).toString("utf8");
    let sawTgSend = false;
    let lastText = "";
    for (const line of chunk.split("\n")) {
      if (!line.trim()) continue;
      let ev: { type?: string; message?: { content?: unknown } };
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type !== "assistant") continue;
      const content = ev.message?.content;
      if (!Array.isArray(content)) continue;
      for (const c of content as Array<{ type?: string; name?: string; input?: { command?: string }; text?: string }>) {
        if (c?.type === "tool_use" && c?.name === "Bash" && TG_SEND_RE.test(c.input?.command ?? "")) {
          sawTgSend = true;
        }
        if (c?.type === "text" && typeof c.text === "string" && c.text.trim()) {
          lastText = c.text;
        }
      }
    }
    return { sawTgSend, lastText };
  }

  // Single-flight: serialize turns so concurrent enqueue() calls can't
  // interleave on the shared screen state. The daemon already awaits each
  // enqueue, but rotation flush + priming could otherwise overlap.
  let chain: Promise<void> = Promise.resolve();

  async function runTurn(text: string): Promise<TurnResult> {
    if (booting) {
      await booting;
      booting = null;
    }
    if (bootError) throw bootError;

    // Record the transcript offset BEFORE the turn so we only scan this turn's
    // appended events afterward (mirrors tg-daemon's external-write diffing).
    const beforeOffset = sessionSize();

    let reply = (await ic.send(text)).trim();

    // Stale-auth screen check (NOTES #6). In interactive mode an auth failure
    // renders as a login screen rather than a stream event. If we see it, mirror
    // the stream-json path: return the canonical AUTH_SIGNAL so tg-daemon's
    // existing AUTH_ERROR_PATTERN handling (alert + kill + respawn) fires, AND
    // mark ourselves dead + kill the pty so even non-dispatch turns (priming /
    // autonomous) trigger a respawn via attachExitHandler. NOTE: the exact TUI
    // login wording is unverified (we couldn't force a real auth failure here);
    // AUTH_SCREEN_PATTERNS may need tuning on first real occurrence.
    const screen = ic.screen();
    if (AUTH_SCREEN_PATTERNS.some((re) => re.test(screen))) {
      log("AUTH SCREEN DETECTED — surfacing auth signal and killing session");
      authFailed = true;
      try { ic.stop(); } catch {}
      return { result: AUTH_SIGNAL, sawTgSend: false };
    }

    // Read this turn's JSONL transcript: reliable source for tool detection and
    // for an empty-reply fallback.
    const tx = readTurnTranscript(beforeOffset);

    // Empty-reply safety net (NOTES #3): a transient async repaint can blank the
    // reply region at the instant send() samples. (1) re-sample the screen once;
    // (2) if STILL empty, fall back to the transcript's last assistant text,
    // which doesn't suffer the alternate-screen scroll-off (NOTES #1).
    if (!reply) {
      await sleep(600);
      reply = ic.reextract(text).trim();
      if (!reply && tx.lastText.trim()) {
        log("empty scrape — falling back to transcript last assistant text");
        reply = tx.lastText.trim();
      }
      if (!reply) log("empty reply after re-sample + transcript fallback");
    }

    // sawTgSend: authoritative from the JSONL (Bash tool_use command contains
    // "bin/tg-send"). We OR in a scan of the scoped scraped reply purely as a
    // cheap backstop for the rare case the transcript file couldn't be resolved;
    // the reply scan alone is unreliable (collapsed tool calls) — see header.
    const sawTgSend = tx.sawTgSend || TG_SEND_RE.test(reply);

    turns++;
    return { result: reply, sawTgSend };
  }

  function enqueue(text: string): Promise<TurnResult> {
    const turn = chain.then(() => runTurn(text));
    // Keep the chain alive even if a turn rejects, so the next enqueue still runs.
    chain = turn.then(
      () => undefined,
      () => undefined,
    );
    return turn;
  }

  async function shutdown(): Promise<void> {
    log("shutting down interactive claude");
    try { ic.stop(); } catch {}
    await Promise.race([proc.exited, sleep(5000)]);
  }

  return {
    proc,
    enqueue,
    shutdown,
    // Auth failure counts as dead so rotateIfNeeded()/attachExitHandler respawn.
    isDead: () => exited || authFailed || !ic.isAlive(),
    getTurns: () => turns,
    // No usage/cache events in interactive mode. Returning 0 means the daemon's
    // cache-pressure rotation (MAX_CACHE_READ) never fires; age + turn-count
    // rotation (MAX_AGE_MS / MAX_TURNS) still bound context growth.
    getLastCacheRead: () => 0,
    spawnedAt,
  };
}
