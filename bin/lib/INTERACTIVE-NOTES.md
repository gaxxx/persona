# Driving interactive Claude Code via a pty — feasibility notes

**Date:** 2026-06-15 · branch `interactive-backend` · worktree `/workspace/.worktrees/interactive`

## TL;DR

**Yes, it works.** We can drive the *interactive* Claude Code TUI through a
pseudo-terminal, send prompts, detect turn completion, and extract the
assistant's reply as clean text — **without `-p`/--print**, so it stays on the
flat subscription. Resident multi-turn on one persistent session works.

Measured reliability after the fixes below: **12/12 turns** across 3 four-turn
runs, plus **4/4** isolated first-turn runs and a clean 2-turn resident demo.
It is **not** as bulletproof as `stream-json` — it is screen-scraping a
repainting TUI — but with the mitigations here it is good enough to build on,
*especially* because the persona normally delivers its own output via
`bin/tg-send.ts` (so the scraped text is a fallback, not the only channel).

## Files

- `bin/lib/interactive-claude.ts` — the module (`InteractiveClaude` class +
  `oneShot()` helper).
- `bin/lib/interactive-claude.demo.ts` — runnable proof. `bun run
  bin/lib/interactive-claude.demo.ts [--multi]`.
- This file.

Dependency added: `@xterm/headless` (pure-JS VT emulator, no native build).

## How the pty is spawned

`node-pty` **does not build** in this image (no C++ toolchain — `node-gyp`
fails). util-linux `script(1)` is the pty provider instead:

```
script -qfc "stty rows 200 cols 120; exec claude --dangerously-skip-permissions" /dev/null
```

- `script` allocates a real pty, runs the wrapped command as the
  controlling-tty child, and relays the pty master to **its** stdout, which we
  capture with `Bun.spawn({stdout:"pipe"})`. We write to `script`'s stdin, which
  reaches the child as keyboard input.
- `stty rows/cols` inside the wrapper sets the pty winsize *before* `exec
  claude`, so the TUI lays out to a known geometry (our headless terminal uses
  the same geometry).
- Env hygiene: we strip `CLAUDECODE` and `CLAUDE_CODE_*` (same as
  `spawnClaude()` in `tg-daemon.ts`) so the nested claude doesn't refuse to
  start as a nested session, and force `TERM=xterm-256color`.

## ANSI / screen handling

The TUI is a **full-screen app on the alternate screen buffer** (`ESC[?1049h`):
it repaints with absolute cursor moves, so naïve ANSI-stripping concatenates
garbage. Instead we feed the raw pty byte stream into a **headless xterm.js**
terminal (`@xterm/headless`) and read the rendered screen buffer
(`buffer.active` → `translateToString`). That gives exactly what a human would
see. This is the single most important design decision — it turns an
unparseable escape soup into clean lines.

## Turn-completion detection

Two independent done-signals, either suffices, both gated on output going quiet
for `idleGraceMs` (default 1.5s):

1. **Working marker** — while Claude is processing, the footer contains
   `esc to interrupt` (present the whole time, *including during tool calls* —
   verified). Turn done = marker appeared, then absent for the grace period.
   This is the reliable signal for slow / agentic / tool-using turns.
2. **Completion footer** — the TUI prints `✻ <verb> for <N>s`
   ("Cooked for 2s", "Brewed for 3s", "Worked for 1s") only *after* a turn
   finishes. A *change* in that footer line is a per-turn done-signal. This
   covers **fast** turns whose `esc to interrupt` marker flickers past between
   150ms polls (the common false-"no-turn" case).

A hard `turnTimeoutMs` (default 240s) caps the wait; a `turnStartTimeoutMs`
(8s) lets an instant/no-op turn fall through.

**How reliable?** The marker-based detection itself is solid. The thing that
was flaky was *extraction*, not detection (below).

## Reply extraction

Anchored on the **echo of the exact prompt we sent** (`❯ <prompt>`), then we
read the `●`-bulleted assistant lines below it until the `✻` footer / input
rule. Anchoring on the prompt (not "the last `❯`") is **required**: the TUI's
live input box shows a *prompt-suggestion ghost* that looks exactly like an
echoed prompt and otherwise hijacks the anchor.

Two reliability fixes were necessary and are in the code:

- **Tall viewport (`rows: 200`).** The alternate screen buffer has **no
  scrollback** — anything scrolling above row 0 is gone forever. Noisy startup
  chrome (Fable-5-unavailable notice, "setup issues", "/passes" promo) eats
  rows; at 60 rows a reply could scroll off and extraction returned empty. A
  tall viewport keeps a turn's content on screen. (The TUI pins the input box to
  the bottom and pads with blank lines, so a tall pty just means more headroom,
  not visual weirdness.)
- **Sampled-best extraction.** Async repaints (startup notices landing, spinner
  teardown) can momentarily blank the reply region at the instant we snapshot.
  We sample the screen up to 8× over ~2s and keep the **longest non-empty**
  result. This took first-turn success from ~85% to 4/4 in stress runs.

## Resident multi-turn

**Works.** One persistent `script`+claude process, one persistent xterm
terminal fed continuously; `send()` is callable repeatedly. The demo's
`--multi` proves turn 2 on the same live session. (We did not need
`claude --continue`; the session is literally still open.) Submitting a prompt:
wrap in **bracketed paste** (`ESC[200~ … ESC[201~`) so multi-line prompts don't
submit early, wait **400ms** for the paste to settle (120ms was too short and
left text sitting in the box — a real bug we hit), then a lone `CR` submits.

## Latency vs stream-json

| | interactive (this) | `claude -p` stream-json |
|---|---|---|
| startup | ~7.6s (incl. 2.5s settle) | ~1–2s |
| fast turn | ~4.6–5.4s | model time + ~0 framing |
| per-turn overhead | ~2.5s (1.5s idle grace + ~1s sampling) | exact event boundaries, ~0 |

The overhead is the price of inferring boundaries from screen quiet instead of
reading explicit `result` events. For a Telegram assistant (human-paced, replies
in seconds) this is **fine**.

## Captured proof (real output)

```
$ bun run bin/lib/interactive-claude.demo.ts --multi
=== TURN 1 REPLY ===
Three words exactly.
=== TURN 2 REPLY (resident) ===
Here are five words now.
```

Other verified turns: multi-line prompt → `BANANA`; "list three fruits" →
`Apple / Banana / Orange`; two-sentence PTY explanation captured in full
including wrapped continuation lines.

## Limitations & failure modes — *brutally honest*

1. **No scrollback (alternate screen).** A reply **taller than the pty
   viewport** loses its top once it scrolls off — unrecoverable from a final
   snapshot. `rows:200` mitigates for normal replies; a very long answer (e.g.
   a big code block) will still be truncated at the top. **Mitigation for real
   use:** have the agent deliver output itself (the persona already calls
   `tg-send.ts`); don't rely on scraping for long output. For full transcripts,
   read the session JSONL under `~/.claude/projects/...` after the turn.
2. **Tool-heavy turns are messy to scrape.** In the Claude Code TUI, tool calls
   *also* render with `●` bullets. The extractor takes everything between the
   prompt echo and the `✻` footer, so a turn that runs tools will include
   tool-call lines, not just the final prose. Fine for the demo's pure-text
   replies; **not** a clean "final message only" extractor for agentic turns.
   Again: the persona's own `tg-send.ts` is the right channel for the actual
   reply text.
3. **Residual first-turn raciness.** Before the `rows:200` + sampled-best +
   2.5s boot-settle fixes, the first turn failed ~10–15% of the time (async
   startup notices repainting over the reply). After the fixes it was 4/4 in
   stress + clean demos, but this is *empirical*, not *guaranteed*. A
   belt-and-suspenders integration should verify the extracted reply is
   non-empty and, if empty, either re-read the session JSONL or re-issue.
4. **Marker/footer strings are version-coupled.** `esc to interrupt` and
   `✻ … for Ns` are UI strings in Claude Code v2.1.x. A future TUI redesign
   could change them and silently break detection. They're centralized
   constants/one regex — easy to update, but it's a maintenance liability that
   `stream-json` does not have.
5. **`script` quirks.** We rely on util-linux `script -qfc`. BSD `script` has a
   different flag syntax; not portable off Linux. If `node-pty` ever builds,
   it'd be a cleaner pty source (direct winsize control, no shell wrapper).
6. **Stale-auth detection** (the daemon's `Not logged in` / `Please run /login`
   handling) is **not** ported here. In interactive mode an auth failure would
   render differently (likely a `/login` prompt in the TUI); the integration
   must add a screen check for that before trusting replies.

## Recommendation for tg-daemon integration

**Worth continuing — with eyes open.** The hard part (drive the TUI, detect
turns, get clean text) is proven. The integration is not a drop-in because the
current daemon leans on stream-json events for per-event logging, idle reset,
auto-send heuristics, and stale-auth detection — all of which become
screen-derived heuristics here. Suggested path:

1. Run a **resident** `InteractiveClaude` as the daemon's claude backend; map
   `enqueue(prompt)` → `send(prompt)`.
2. **Don't** depend on scraped text as the primary reply — keep the persona
   calling `tg-send.ts`; use the scraped reply only for the auto-send fallback
   and logging. This sidesteps limitations #1 and #2 almost entirely.
3. Port stale-auth detection as a screen check (`/login`, "Not logged in").
4. Add the empty-reply safety net from limitation #3.
5. Keep the marker/footer strings in one place and add a startup self-test that
   fails loudly if the working marker never appears on a known prompt (catches
   #4 on deploy rather than in production).

## Phase 1 integration (2026-06-16)

Wired the driver into `tg-daemon.ts` as an **opt-in alternate backend**. The
live daemon is unaffected until someone flips an env flag.

### Files
- `bin/lib/claude-proc.ts` — shared `ClaudeProc` / `TurnResult` interfaces (was
  inline in tg-daemon.ts; extracted so both backends import the same shape, no
  import cycle).
- `bin/lib/tui-strings.ts` — centralized version-coupled TUI strings
  (`WORKING_MARKER`, `COMPLETION_FOOTER_RE`, `AUTH_SCREEN_PATTERNS`, `AUTH_SIGNAL`,
  `TG_SEND_RE`). `interactive-claude.ts` now imports the first two from here, so
  limitation #4 (version drift) is a one-file fix.
- `bin/lib/interactive-backend.ts` — `spawnInteractiveClaude(): ClaudeProc`, the
  adapter.
- `bin/lib/interactive-backend.smoke.ts` — self-contained, no-Telegram test.
- `interactive-claude.ts` — added public `subprocess` getter, `isAlive()`,
  `reextract()`; no behaviour change to the driver itself.

### The env flag
```
TG_BACKEND=interactive   # opt-in: drive the interactive TUI over a pty
(unset)                  # DEFAULT: existing stream-json `claude -p` backend
```
In `tg-daemon.ts` all four `spawnClaude()` call sites (initial spawn,
auto-respawn-on-exit, dead-respawn, rotation) now call `makeBackend()`, which is
`useInteractive ? spawnInteractiveClaude() : spawnClaude()`. **Default is
byte-for-byte the old path** — the only added code on the default path is one
`process.env` read and a ternary. Importing the backend module has no
side-effects (only declarations), so an unset flag changes nothing.

### sawTgSend — how it actually works (and why NOT the brief's screen scan)
The original plan was to detect a tg-send by scanning the scraped screen for a
`●`-bulleted `bin/tg-send` command line. **This does not work**: Claude Code
v2.1.x *collapses* tool calls on screen to `Ran N shell command(s)` and never
shows the command text. A screen scan would report `sawTgSend ≈ always-false`,
so the daemon would auto-send the scraped reply ON TOP of the persona's own
`tg-send.ts` message — a double-send.

Instead the backend reads the interactive session's **JSONL transcript**
(`~/.claude/projects/<cwd>/<session-id>.jsonl`), which records full `tool_use`
events incl. the Bash `command`. It scans the bytes appended *during this turn*
for a `Bash` tool_use whose command matches `bin/tg-send` — the **exact same
logic** the stream-json path uses on its `assistant` events. This is reliable,
not heuristic. Verified in the smoke test (`sawTgSend=true` for a turn that runs
`echo …bin/tg-send…`, `false` for pure-text turns).

Residual imprecision / risks:
- **Session-file pinning.** We pin to the first *new* `.jsonl` that appears in
  the cwd's project dir after spawn. If another claude session starts in the
  *same cwd* in the tiny window between our spawn and our first turn, we could
  pin the wrong file. Rare; the `/quick` path uses cwd `/tmp` (different dir) so
  it's not a factor, but a task-runner worker sharing the cwd theoretically
  could be. Backstop: a scoped scan of the scraped reply is OR'd in.
- **`result` is still screen-scraped** (per the brief), with the transcript's
  last assistant text as the empty-reply fallback. Long replies can still
  scroll off the alternate screen (#1) — accepted because the persona delivers
  via `tg-send.ts`; the scrape is fallback + logging only.

### Stale-auth
After each turn we scan the screen for `AUTH_SCREEN_PATTERNS`. On a match we
return `AUTH_SIGNAL` ("Please run /login", which matches the daemon's existing
`AUTH_ERROR_PATTERN`) **and** mark the backend dead + kill the pty, so both the
dispatch-level handler (alert + respawn) and `attachExitHandler` fire.
⚠️ **Unverified:** we could not force a real interactive auth failure in this
env, so the exact TUI login wording is a guess. Tune `AUTH_SCREEN_PATTERNS` in
`tui-strings.ts` on the first real occurrence.

### What is NOT ported (known gaps)
- **MCP status cache / `.mcp.json` filtering.** `spawnClaude()` calls
  `writeMcpConfig()` and learns per-server health from `system/init` events;
  the interactive path has no such events and does not refresh `.mcp.json`. The
  interactive claude reads whatever `.mcp.json` already exists. Failed MCP
  servers won't be auto-excluded/backed-off in interactive mode.
- **Rate-limit notifications** (`rate_limit_event`) — no equivalent event on the
  interactive path, so the preemptive "90% used" / "rate-limited" Telegram
  notices won't fire under `TG_BACKEND=interactive`.
- **`getLastCacheRead()` returns 0** — cache-pressure rotation (`MAX_CACHE_READ`)
  never triggers. Age (`MAX_AGE_MS`) and turn-count (`MAX_TURNS`) rotation still
  bound context growth.
- **Per-event logging** (the daemon's `log("claude:", line)` stream) — replaced
  by coarse per-turn `[interactive-backend]` log lines.
- **Latency** is higher (~7.6s boot, ~2.5s/turn overhead) than stream-json.

### Reliability, honestly
The smoke test is **10/10** (boot + 2 resident text turns + JSONL tg-send
detection + accessors). But that is a clean-room exercise: short prompts, no
attachments, no MCP, no concurrent sessions. The real persona does Reads of
images/PDFs, multi-tool turns, and long replies — those will exercise the
scroll-off (#1) and the residual first-turn raciness (#3) that the driver notes
warn about. Treat Phase 1 as "works in the happy path, not yet battle-tested".

### Cutover steps for a human (Phase 1 → live)
1. Review this branch (`interactive-backend`) and decide.
2. Confirm interactive `claude` is logged in for the daemon's user/cwd
   (`claude` once interactively, ensure no `/login` prompt).
3. Set `TG_BACKEND=interactive` in the daemon's environment (`.env` /
   docker-compose / launch script — wherever tg-daemon's env comes from).
4. **Restart tg-daemon.** ⚠️ The restart **kills the current inner session** —
   any in-RAM working state not yet flushed to disk is lost (same as any
   rotation). Pick a quiet moment.
5. Watch `data/daemon.log` for `TG_BACKEND=interactive — using pty TUI backend`
   and `pinned session transcript: …`. Send a test message; confirm exactly one
   reply (no double-send) and that a `tg-send`-using turn is NOT double-sent.
6. Rollback = unset `TG_BACKEND` and restart. Zero code change needed.
