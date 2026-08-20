/**
 * Shared backend contract for tg-daemon's Claude subprocess.
 *
 * Both backends implement `ClaudeProc`:
 *   - the default stream-json backend (`spawnClaude()` in tg-daemon.ts), and
 *   - the opt-in interactive-TUI backend (`spawnInteractiveClaude()` in
 *     bin/lib/interactive-backend.ts).
 *
 * Extracted into its own module so the interactive backend can import the
 * shape without creating an import cycle with the daemon entrypoint.
 */
import type { Subprocess } from "bun";

export interface TurnResult {
  result: string;       // assistant's final text for the turn
  sawTgSend: boolean;   // true if the turn invoked bin/tg-send* (suppress auto-send)
}

export interface ClaudeProc {
  /** Underlying child process. The daemon reads `.exited` (auto-respawn) and
   *  calls `.kill()` (force respawn on auth failure). For the interactive
   *  backend this is the `script(1)` pty process wrapping claude. */
  proc: Subprocess<"pipe", "pipe", "pipe">;
  enqueue: (text: string) => Promise<TurnResult>;
  shutdown: () => Promise<void>;
  isDead: () => boolean;
  getTurns: () => number;
  getLastCacheRead: () => number;
  spawnedAt: number;
}
