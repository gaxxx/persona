#!/usr/bin/env bun
/**
 * Self-contained smoke test for the interactive ClaudeProc backend. Does NOT
 * touch Telegram and does NOT start tg-daemon. It exercises the adapter in
 * isolation:
 *   1. spawn the backend (boots the interactive TUI over a pty)
 *   2. enqueue a pure-text turn  → result contains PING, sawTgSend=false
 *   3. enqueue a second turn      → result contains PONG (resident multi-turn)
 *   4. enqueue a turn that runs a HARMLESS `echo …bin/tg-send…` Bash command
 *      → sawTgSend=true (proves the heuristic; nothing is sent to Telegram)
 *
 * Run:  bun run bin/lib/interactive-backend.smoke.ts
 * Exits 0 on all-pass, 1 otherwise.
 */
import { spawnInteractiveClaude } from "./interactive-backend";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  const tag = cond ? "PASS" : "FAIL";
  if (!cond) failures++;
  console.log(`[${tag}] ${name}${detail ? ` — ${detail}` : ""}`);
}

const t0 = Date.now();
const c = spawnInteractiveClaude();
console.log(`spawned backend; isDead=${c.isDead()} spawnedAt set=${!!c.spawnedAt}`);

try {
  // --- Turn 1: pure text -----------------------------------------------------
  const r1 = await c.enqueue('Reply with exactly this and nothing else: PING');
  console.log(`\n=== TURN 1 result (${Date.now() - t0}ms) ===\n${r1.result}\n=== end ===`);
  check("turn1 result contains PING", /PING/.test(r1.result), JSON.stringify(r1.result.slice(0, 120)));
  check("turn1 sawTgSend is false (pure text)", r1.sawTgSend === false, `sawTgSend=${r1.sawTgSend}`);
  check("getTurns()==1 after one turn", c.getTurns() === 1, `turns=${c.getTurns()}`);
  check("getLastCacheRead()==0 (no usage events)", c.getLastCacheRead() === 0);

  // --- Turn 2: resident multi-turn ------------------------------------------
  const r2 = await c.enqueue('Reply with exactly this and nothing else: PONG');
  console.log(`\n=== TURN 2 result ===\n${r2.result}\n=== end ===`);
  check("turn2 result contains PONG (resident session)", /PONG/.test(r2.result), JSON.stringify(r2.result.slice(0, 120)));
  check("getTurns()==2", c.getTurns() === 2, `turns=${c.getTurns()}`);

  // --- Turn 3: sawTgSend heuristic ------------------------------------------
  // Harmless: a plain echo whose command line contains the bin/tg-send path.
  // Nothing is actually sent to Telegram.
  const r3 = await c.enqueue(
    'Use the Bash tool to run EXACTLY this command (it is a harmless echo, run it verbatim): echo bin/tg-send.ts-SMOKE-NOOP . Then reply with the single word DONE.',
  );
  console.log(`\n=== TURN 3 result ===\n${r3.result}\n=== end ===`);
  check("turn3 sawTgSend detected (bin/tg-send in scraped Bash line)", r3.sawTgSend === true, `sawTgSend=${r3.sawTgSend}`);

  check("isDead() false after healthy turns", c.isDead() === false);
} catch (e) {
  failures++;
  console.error("SMOKE TEST THREW:", (e as Error).message);
  console.error((e as Error).stack);
} finally {
  await c.shutdown();
}

console.log(`\n${failures === 0 ? "ALL PASS ✅" : `${failures} CHECK(S) FAILED ❌`} (total ${Date.now() - t0}ms)`);
process.exit(failures === 0 ? 0 : 1);
