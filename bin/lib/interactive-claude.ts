/**
 * interactive-claude.ts — drive the INTERACTIVE Claude Code TUI through a
 * pseudo-terminal and extract assistant replies, WITHOUT using `-p`/--print.
 *
 * Why: as of 2026-06-15 Anthropic bills `claude -p` (headless / Agent SDK)
 * against a separate metered Agent-SDK credit, while the INTERACTIVE TUI still
 * draws from the flat subscription. The persona daemon currently relies on
 * `claude -p --output-format stream-json`; to stay on the flat plan it must
 * drive the interactive TUI instead. There is no clean programmatic non-`-p`
 * interface, so we drive the real TUI over a pty and scrape its screen.
 *
 * How it works
 * ------------
 * - pty: `node-pty` does not build in this image (no native toolchain), so we
 *   use util-linux `script(1)` as the pty provider:
 *       script -qfc "<cmd>" /dev/null
 *   `script` allocates a pty, runs <cmd> as the controlling-tty child, and
 *   relays the pty master to its own stdout (which we capture via Bun.spawn).
 *   We set the pty window size from inside the wrapped command with `stty`
 *   so the TUI lays out to a known cols/rows.
 * - render: the TUI is a full-screen app that repaints with absolute cursor
 *   moves, so naive ANSI-stripping garbles it. We feed the raw pty stream into
 *   a headless xterm.js terminal (@xterm/headless) and read the rendered screen
 *   buffer — the same bytes a real terminal would show.
 * - turn detection: while Claude is working the footer contains
 *   "esc to interrupt"; when the turn finishes it disappears and the input box
 *   returns. We treat a turn as complete when that marker has appeared and then
 *   stays absent for `idleGraceMs`, with a quiet-output confirmation. A hard
 *   `turnTimeoutMs` caps the wait.
 * - input: prompts are sent inside a bracketed-paste envelope
 *   (ESC[200~ … ESC[201~) so multi-line text doesn't submit early, then a
 *   lone CR submits.
 *
 * LIMITATIONS — see bin/lib/INTERACTIVE-NOTES.md. Most important: the TUI uses
 * the alternate screen buffer (no scrollback), so a reply taller than the pty
 * viewport loses its top once it scrolls off. Keep `rows` generous, and prefer
 * having the agent deliver its own output (the persona already calls
 * bin/tg-send.ts) rather than relying on screen-scraping for long replies.
 */

import { Terminal } from "@xterm/headless";
import type { Subprocess } from "bun";
import { WORKING_MARKER, COMPLETION_FOOTER_RE } from "./tui-strings";

export interface InteractiveClaudeOpts {
  cols?: number;
  rows?: number;
  /** Model alias/name, e.g. "haiku". Omit to use the configured default. */
  model?: string;
  /** Extra args appended after the base claude args. */
  extraArgs?: string[];
  cwd?: string;
  /** Max ms to wait for the TUI to boot to a ready input box. */
  bootTimeoutMs?: number;
  /** ms of "esc to interrupt" absence + output quiet that confirms turn end. */
  idleGraceMs?: number;
  /** Hard cap on a single turn. */
  turnTimeoutMs?: number;
  /** Max ms to wait for a turn to *start* (marker to appear) before assuming
   *  an instant/no-op turn and falling back to quiet detection. */
  turnStartTimeoutMs?: number;
  /** Write raw pty stream to this path (debug). */
  rawDumpPath?: string;
  debug?: boolean;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class InteractiveClaude {
  private proc: Subprocess<"pipe", "pipe", "pipe"> | null = null;
  private term: Terminal;
  private opts: Required<Omit<InteractiveClaudeOpts, "model" | "extraArgs" | "cwd" | "rawDumpPath">> &
    Pick<InteractiveClaudeOpts, "model" | "extraArgs" | "cwd" | "rawDumpPath">;
  private lastChunkAt = 0;
  private raw = "";
  private started = false;

  constructor(opts: InteractiveClaudeOpts = {}) {
    this.opts = {
      cols: opts.cols ?? 120,
      // Tall viewport on purpose: the TUI uses the alternate screen buffer
      // (no scrollback), so anything that scrolls above row 0 is unrecoverable.
      // A big height keeps a turn's reply on screen for extraction.
      rows: opts.rows ?? 200,
      bootTimeoutMs: opts.bootTimeoutMs ?? 25_000,
      idleGraceMs: opts.idleGraceMs ?? 1_500,
      turnTimeoutMs: opts.turnTimeoutMs ?? 240_000,
      turnStartTimeoutMs: opts.turnStartTimeoutMs ?? 8_000,
      debug: opts.debug ?? false,
      model: opts.model,
      extraArgs: opts.extraArgs,
      cwd: opts.cwd,
      rawDumpPath: opts.rawDumpPath,
    };
    this.term = new Terminal({
      cols: this.opts.cols,
      rows: this.opts.rows,
      allowProposedApi: true,
      scrollback: 5000,
    });
  }

  private dbg(...a: unknown[]) {
    if (this.opts.debug) console.error("[ic]", ...a);
  }

  /** Spawn the pty + claude and wait until the input box is ready. */
  async start(): Promise<void> {
    if (this.started) return;
    // Strip Claude Code session env so the nested claude doesn't refuse to
    // start as a nested session (mirrors spawnClaude() in tg-daemon.ts).
    const childEnv: Record<string, string> = { ...process.env } as Record<string, string>;
    for (const k of Object.keys(childEnv)) {
      if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) delete childEnv[k];
    }
    // Force a stable terminal so xterm and the TUI agree on capabilities.
    childEnv.TERM = "xterm-256color";

    const claudeArgs = ["claude", "--dangerously-skip-permissions"];
    if (this.opts.model) claudeArgs.push("--model", this.opts.model);
    if (this.opts.extraArgs) claudeArgs.push(...this.opts.extraArgs);

    // Set the pty winsize from inside the wrapped command, then exec claude.
    // `exec` so claude becomes the controlling-tty process directly.
    const inner = `stty rows ${this.opts.rows} cols ${this.opts.cols}; exec ${claudeArgs
      .map((a) => (/[^\w@%+=:,./-]/.test(a) ? `'${a.replace(/'/g, `'\\''`)}'` : a))
      .join(" ")}`;

    this.dbg("spawn:", inner);
    this.proc = Bun.spawn(["script", "-qfc", inner, "/dev/null"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: childEnv,
      cwd: this.opts.cwd,
    });

    // Pump pty -> xterm continuously.
    const dec = new TextDecoder();
    (async () => {
      const reader = this.proc!.stdout.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const s = dec.decode(value);
        this.raw += s;
        this.lastChunkAt = Date.now();
        this.term.write(s);
      }
    })();
    (async () => {
      const reader = this.proc!.stderr.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        this.dbg("stderr:", dec.decode(value).trim());
      }
    })();

    // Wait for the input box to be ready: the footer mode line
    // ("bypass permissions on" / agents hint) is rendered and we are NOT
    // mid-turn. Fall back to a quiet period if markers shift between versions.
    const deadline = Date.now() + this.opts.bootTimeoutMs;
    while (Date.now() < deadline) {
      await sleep(250);
      const screen = this.screen();
      const ready =
        /❯/.test(screen) &&
        !screen.includes(WORKING_MARKER) &&
        Date.now() - this.lastChunkAt > 600;
      if (ready) {
        this.dbg("boot ready; waiting for async startup notices to settle");
        // The TUI prints async chrome (model notices, /passes promo, setup
        // warnings) a few seconds AFTER the input box appears. Those repaints
        // race with and can clobber the first turn's reply. Wait for the screen
        // to stop changing before declaring ready.
        await this.waitStable(10_000, 2_500);
        this.started = true;
        if (this.opts.rawDumpPath) await Bun.write(this.opts.rawDumpPath, this.raw);
        return;
      }
    }
    if (this.opts.rawDumpPath) await Bun.write(this.opts.rawDumpPath, this.raw);
    throw new Error("interactive-claude: TUI did not reach a ready input box within bootTimeoutMs");
  }

  /** Wait until the output stream is quiet (no new bytes) for `quietMs`, or
   *  until `maxMs` elapses. Used to let async repaints settle. */
  private async waitStable(maxMs: number, quietMs: number): Promise<void> {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      await sleep(200);
      if (Date.now() - this.lastChunkAt >= quietMs) return;
    }
  }

  /** Current rendered screen incl. scrollback, as plain text lines. */
  screen(): string {
    const buf = this.term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      lines.push(line ? line.translateToString(true) : "");
    }
    return lines.join("\n");
  }

  /** The most recent completion-footer line ("✻ <verb>ed for Ns"), or "".
   *  The TUI prints this only after a turn finishes, so a change in its text
   *  is a reliable per-turn done-signal. */
  private completionFooter(): string {
    const lines = this.screen().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const t = lines[i].trim();
      // e.g. "✻ Cooked for 2s", "✻ Brewed for 3s" — exclude the live spinner,
      // which contains "esc to interrupt".
      if (COMPLETION_FOOTER_RE.test(t) && !t.includes(WORKING_MARKER)) return t;
    }
    return "";
  }

  private write(s: string) {
    this.proc!.stdin.write(new TextEncoder().encode(s));
    this.proc!.stdin.flush();
  }

  /**
   * Send one prompt, wait for the turn to complete, return the assistant text.
   * Resident: the session stays alive for the next send().
   */
  async send(prompt: string): Promise<string> {
    if (!this.started) throw new Error("interactive-claude: call start() first");
    if (!this.proc) throw new Error("interactive-claude: not running");

    const footerBefore = this.completionFooter();
    // Bracketed paste so multi-line prompts don't submit early. A CR submits,
    // but only after the paste has settled — ~120ms is too soon and leaves the
    // text sitting in the input box. 400ms is reliably enough.
    this.write("\x1b[200~" + prompt + "\x1b[201~");
    await sleep(400);
    this.write("\r");

    // Completion detection. Two independent done-signals, either suffices:
    //  (a) the working marker ("esc to interrupt") appeared and then stayed
    //      absent for idleGraceMs — covers slow/agentic turns (the marker is
    //      shown the whole time, including during tool calls).
    //  (b) a NEW completion footer ("✻ …ed for Ns") appeared — covers fast
    //      turns whose marker flickers by between polls.
    // Both require output quiet for idleGraceMs to avoid cutting a render pause.
    const turnDeadline = Date.now() + this.opts.turnTimeoutMs;
    const startDeadline = Date.now() + this.opts.turnStartTimeoutMs;
    let sawWorking = false;
    let absentSince = 0;
    while (Date.now() < turnDeadline) {
      await sleep(150);
      const screen = this.screen();
      const working = screen.includes(WORKING_MARKER);
      const quietFor = Date.now() - this.lastChunkAt;
      const footerNow = this.completionFooter();
      const newFooter = !!footerNow && footerNow !== footerBefore;

      if (working) {
        sawWorking = true;
        absentSince = 0;
        continue;
      }
      if (absentSince === 0) absentSince = Date.now();
      const absentFor = Date.now() - absentSince;
      const quietEnough = quietFor >= this.opts.idleGraceMs && absentFor >= this.opts.idleGraceMs;
      if (!quietEnough) continue;

      if (sawWorking || newFooter) {
        this.dbg("turn complete (sawWorking=", sawWorking, "newFooter=", newFooter, ")");
        break;
      }
      // No marker ever seen and no fresh footer, but the start window elapsed
      // and we are quiet: treat as a no-op/instant turn and stop waiting.
      if (Date.now() > startDeadline) {
        this.dbg("turn start window elapsed with no activity; assuming no-op");
        break;
      }
    }

    // Extraction is sampled over a short window rather than taken once: an
    // async repaint (startup notices, spinner teardown) can momentarily clobber
    // the reply region at the instant we snapshot. The reply persists in the
    // conversation history, so we sample several times and keep the longest
    // non-empty result, which rides over transient repaints.
    let reply = "";
    for (let attempt = 0; attempt < 8; attempt++) {
      const r = this.extractReply(prompt);
      if (r.length > reply.length) reply = r;
      // Once we have something, one more confirming sample is enough.
      if (reply && attempt >= 2) break;
      await sleep(300);
    }
    if (this.opts.rawDumpPath) await Bun.write(this.opts.rawDumpPath, this.raw);
    if (this.opts.debug) console.error("[ic] --- live screen ---\n" + this.screen() + "\n[ic] --- end screen ---");
    return reply;
  }

  /**
   * Extract the assistant's text for the just-finished turn from the rendered
   * screen. We anchor on the echo of the prompt we actually sent ("❯ <prompt>")
   * and read the `●`-bulleted assistant lines below it, stopping at the
   * completion footer (✻ …). Anchoring on the prompt (not "the last ❯") is
   * required because the TUI's live input box can show a *prompt suggestion*
   * ghost that looks like an echoed prompt.
   */
  private extractReply(prompt: string): string {
    const lines = this.screen().split("\n");
    const firstLine = prompt.split("\n")[0].trim();
    const needle = firstLine.slice(0, 40);
    // Find the LAST echo line that matches the prompt we sent (last, because an
    // identical prompt may appear in scrollback from a previous turn).
    let echoIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      const t = lines[i].trim();
      if (t.startsWith("❯") && needle && t.includes(needle)) {
        echoIdx = i;
        break;
      }
    }
    // Fallback: last non-empty ❯ box if we somehow can't match the prompt.
    if (echoIdx < 0) {
      for (let i = lines.length - 1; i >= 0; i--) {
        const t = lines[i].trim();
        if (t.startsWith("❯") && t.replace(/^❯\s*/, "").length > 0) {
          echoIdx = i;
          break;
        }
      }
    }
    const startIdx = echoIdx >= 0 ? echoIdx + 1 : 0;
    const out: string[] = [];
    let inBullet = false;
    for (let i = startIdx; i < lines.length; i++) {
      const raw = lines[i];
      const t = raw.trim();
      // Stop at completion footer / input rule.
      if (/^[─━]{5,}/.test(t)) break;
      if (/^✻/.test(t)) break; // "✻ Cooked for Ns" footer
      if (t.startsWith("❯")) break; // next/live input box
      if (t.startsWith("●")) {
        inBullet = true;
        const body = t.replace(/^●\s*/, "");
        if (body) out.push(body);
        continue;
      }
      // Continuation lines of a bullet are indented and non-empty.
      if (inBullet) {
        if (t === "") {
          inBullet = false;
          out.push("");
        } else {
          out.push(t);
        }
      }
    }
    return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  /** The underlying `script(1)` pty subprocess, or null before start(). Used by
   *  the tg-daemon backend adapter which needs `.exited` / `.kill()`. Note: the
   *  Bun.spawn in start() runs synchronously before start()'s first `await`, so
   *  this is non-null as soon as start() has been *called* (even un-awaited). */
  get subprocess(): Subprocess<"pipe", "pipe", "pipe"> | null {
    return this.proc;
  }

  /** True while the pty child is running. */
  isAlive(): boolean {
    return !!this.proc && this.proc.exitCode === null;
  }

  /** Re-extract the reply for `prompt` from the CURRENT screen, without
   *  re-sending. Used by the backend's empty-reply safety net (NOTES #3) to
   *  re-sample after a transient repaint blanked the reply at send() time. */
  reextract(prompt: string): string {
    return this.extractReply(prompt);
  }

  stop() {
    try {
      if (this.proc) {
        // Try a graceful quit, then kill.
        try {
          this.write("\x1b");
          this.write("/quit\r");
        } catch {}
        this.proc.kill();
      }
    } catch {}
    this.proc = null;
    this.started = false;
  }
}

/** One-shot convenience: start, send one prompt, return reply, stop. */
export async function oneShot(prompt: string, opts: InteractiveClaudeOpts = {}): Promise<string> {
  const ic = new InteractiveClaude(opts);
  await ic.start();
  try {
    return await ic.send(prompt);
  } finally {
    ic.stop();
  }
}
