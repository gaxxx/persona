/**
 * Proof for interactive-claude.ts. Drives ONE real interactive turn through a
 * pty and prints the captured reply. Run:
 *   bun run bin/lib/interactive-claude.demo.ts
 *
 * Pass --multi to additionally prove a RESIDENT second turn on the same session.
 */
import { InteractiveClaude } from "./interactive-claude.ts";

const multi = process.argv.includes("--multi");

const ic = new InteractiveClaude({ debug: true, rawDumpPath: "/tmp/ic-demo.raw" });
const t0 = Date.now();
await ic.start();
console.error(`[demo] booted in ${Date.now() - t0}ms`);

const tA = Date.now();
const r1 = await ic.send("Reply with exactly three words.");
console.error(`[demo] turn1 took ${Date.now() - tA}ms`);
console.log("=== TURN 1 REPLY ===");
console.log(r1);

if (multi) {
  const tB = Date.now();
  const r2 = await ic.send("Now reply with exactly five words.");
  console.error(`[demo] turn2 took ${Date.now() - tB}ms`);
  console.log("=== TURN 2 REPLY (resident) ===");
  console.log(r2);
}

ic.stop();
process.exit(0);
