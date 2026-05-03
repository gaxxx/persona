#!/usr/bin/env bun
/**
 * Ground-truth routing tester. For each routing test case in cases.md, spawns
 * a fresh `claude -p` subprocess with a routing-test priming, feeds the input
 * as a [Telegram event], and parses the model's "SKILL=<name>" response.
 *
 * Slow (~10-30s/case) and costs real API tokens. Use sparingly — for daily
 * iteration, the cheap offline `/assistant-test routing` (REPL-judged) is fine.
 *
 * Run: bun run bin/test-routing-real.ts [--ids 36,37,38] [--tag routing]
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "fs";

const VAULT = process.env.VAULT_PATH;
if (!VAULT) {
  console.error("FATAL: VAULT_PATH not set");
  process.exit(1);
}
const CASES_FILE = `${VAULT}/persona/tests/cases.md`;
const RESULTS_DIR = `${VAULT}/persona/tests`;
const PER_CASE_TIMEOUT_MS = 90 * 1000;

const TEST_PRIMING = `You are simulating the personal assistant in ROUTING-TEST mode.

Read CLAUDE.md (cwd) and \`<vault>/persona/USER.md\` to understand the routing rules and the skill catalog.

Each user turn is one [Telegram event] JSON. Your ONLY job is to identify which skill / tool you would route this message to per CLAUDE.md's rules. **DO NOT actually invoke any tool or skill.** Don't read other files, don't call MCP, don't send Telegram. Just decide.

Respond with EXACTLY one line in this format:
SKILL=<name>

Valid <name> values:
  game-time, kb, calendar, gmail, gmail-digest, websearch, memory, task, direct

If unsure between two, pick the more specific one. If the message is casual chat with no skill needed, use \`direct\`.

Acknowledge this priming with the single word READY (no SKILL= line for the priming itself).`;

interface TestCase {
  id: number;
  input: string;
  expect_skill: string;
  tags: string[];
}

function parseCases(md: string): TestCase[] {
  const cases: TestCase[] = [];
  for (const line of md.split("\n")) {
    if (!line.startsWith("|")) continue;
    if (line.match(/^\|\s*-+/)) continue; // separator
    const cells = line.split("|").map((s) => s.trim());
    // cells[0] and cells[last] are empty (before/after leading/trailing |)
    const real = cells.slice(1, -1);
    if (real.length < 4) continue;
    const id = Number(real[0]);
    if (!Number.isFinite(id)) continue; // header row "ID" → NaN
    cases.push({
      id,
      input: real[1],
      expect_skill: real[2],
      tags: real[real.length - 1].split(",").map((s) => s.trim()).filter(Boolean),
    });
  }
  return cases;
}

async function routeOne(tc: TestCase): Promise<{ actual: string | null; ms: number; raw: string }> {
  const childEnv = { ...process.env };
  for (const k of Object.keys(childEnv)) {
    if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) delete childEnv[k];
  }
  const proc = Bun.spawn(
    ["claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions"],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: childEnv },
  );

  // Drain stderr (don't crash on noise)
  (async () => {
    const r = proc.stderr.getReader();
    while (true) {
      const { done } = await r.read();
      if (done) break;
    }
  })();

  const enc = new TextEncoder();
  const send = (text: string) => {
    proc.stdin.write(
      enc.encode(JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n"),
    );
  };

  // Priming first turn
  send(TEST_PRIMING);

  // Then the test event
  const eventJson = JSON.stringify({
    chat_id: -999,
    from: "TestRunner",
    text: tc.input,
    date: new Date().toISOString(),
    message_id: tc.id,
  });
  send(`[Telegram event] ${eventJson}`);
  proc.stdin.end();

  const start = Date.now();
  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let resultsSeen = 0;
  let lastResult = "";
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    try { proc.kill(); } catch {}
  }, PER_CASE_TIMEOUT_MS);

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value);
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.type === "result") {
          resultsSeen++;
          if (resultsSeen === 2) lastResult = String(ev.result ?? "");
        }
      } catch {}
    }
    if (resultsSeen >= 2) {
      try { proc.kill(); } catch {}
      break;
    }
  }
  clearTimeout(timer);
  await proc.exited;

  if (timedOut) return { actual: null, ms: Date.now() - start, raw: "<timeout>" };
  const m = lastResult.match(/SKILL=([\w-]+)/);
  return { actual: m ? m[1] : null, ms: Date.now() - start, raw: lastResult.slice(0, 120) };
}

// ---- Main ----------------------------------------------------------------

const argv = process.argv.slice(2);
const idsArg = argv.find((a) => a.startsWith("--ids="))?.slice("--ids=".length);
const tagArg = argv.find((a) => a.startsWith("--tag="))?.slice("--tag=".length) ?? "routing";
const onlyIds = idsArg ? new Set(idsArg.split(",").map(Number)) : null;

const md = readFileSync(CASES_FILE, "utf-8");
let cases = parseCases(md).filter((c) => c.tags.includes(tagArg));
if (onlyIds) cases = cases.filter((c) => onlyIds.has(c.id));
console.log(`Running ${cases.length} routing tests via real claude -p ...`);

let passed = 0, failed = 0;
const results: Array<{ id: number; input: string; expect: string; actual: string | null; pass: boolean; ms: number; raw: string }> = [];
for (const c of cases) {
  process.stdout.write(`  ${String(c.id).padStart(3)}. ${c.input.slice(0, 38).padEnd(40)} -> `);
  const { actual, ms, raw } = await routeOne(c);
  const pass = actual === c.expect_skill;
  console.log(`${(actual ?? "?").padEnd(14)} ${pass ? "PASS" : `FAIL (want ${c.expect_skill})`}  [${ms}ms]`);
  if (!pass && actual === null) console.log(`     raw: ${raw}`);
  results.push({ id: c.id, input: c.input, expect: c.expect_skill, actual, pass, ms, raw });
  pass ? passed++ : failed++;
}
console.log(`\nResults: ${passed}/${cases.length} passed (${failed} failed)`);

if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace(/\..*/, "");
const out = `${RESULTS_DIR}/${stamp}-real.json`;
const totalMs = results.reduce((sum, r) => sum + r.ms, 0);
const meanMs = Math.round(totalMs / Math.max(results.length, 1));
writeFileSync(
  out,
  JSON.stringify(
    { timestamp: new Date().toISOString(), mode: "routing-real", total: cases.length, passed, failed, totalMs, meanMs, results },
    null,
    2,
  ),
);
console.log(`Saved: ${out}`);
console.log(`Timing: total=${(totalMs / 1000).toFixed(1)}s, mean=${meanMs}ms`);

// ---- Compare against most recent prior run -------------------------------

// Per-case latency from the LLM backend has high natural variance, so we
// only flag big drifts. Aggregate (40 cases averaged) is more stable.
const PER_CASE_PCT = 30;
const AGGREGATE_PCT = 10;

const priors = readdirSync(RESULTS_DIR)
  .filter((f) => f.endsWith("-real.json") && `${RESULTS_DIR}/${f}` !== out)
  .sort()
  .reverse();
if (priors.length === 0) {
  console.log("No prior run to compare against.");
} else {
  const priorPath = `${RESULTS_DIR}/${priors[0]}`;
  let prior;
  try {
    prior = JSON.parse(readFileSync(priorPath, "utf-8"));
  } catch {
    console.log(`(could not parse prior ${priors[0]} for comparison)`);
    prior = null;
  }
  if (prior?.results) {
    const priorBy: Record<number, { ms: number }> = {};
    for (const r of prior.results) priorBy[r.id] = { ms: r.ms };
    const drifts: string[] = [];
    let priorTotalForIntersection = 0;
    let nowTotalForIntersection = 0;
    let intersectionCount = 0;
    for (const r of results) {
      const p = priorBy[r.id];
      if (!p) continue;
      intersectionCount++;
      priorTotalForIntersection += p.ms;
      nowTotalForIntersection += r.ms;
      const pct = ((r.ms - p.ms) / p.ms) * 100;
      if (Math.abs(pct) >= PER_CASE_PCT) {
        const sign = pct > 0 ? "+" : "";
        drifts.push(`  ⚠ ${String(r.id).padStart(3)}. ${r.input.slice(0, 30).padEnd(32)} ${p.ms}ms → ${r.ms}ms (${sign}${pct.toFixed(0)}%)`);
      }
    }
    console.log(`\nCompared against ${priors[0]} (${intersectionCount} overlapping cases)`);
    if (intersectionCount > 0) {
      const aggPct = ((nowTotalForIntersection - priorTotalForIntersection) / priorTotalForIntersection) * 100;
      const aggSign = aggPct > 0 ? "+" : "";
      const ok = Math.abs(aggPct) < AGGREGATE_PCT;
      console.log(`Aggregate (intersection): ${(priorTotalForIntersection / 1000).toFixed(1)}s → ${(nowTotalForIntersection / 1000).toFixed(1)}s (${aggSign}${aggPct.toFixed(1)}%) ${ok ? "✓" : "⚠"}`);
    }
    if (drifts.length === 0) {
      console.log(`Per-case timings within ±${PER_CASE_PCT}% — no drift.`);
    } else {
      console.log(`Per-case drifts >${PER_CASE_PCT}%:`);
      for (const d of drifts) console.log(d);
    }
  }
}
