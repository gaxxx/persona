#!/usr/bin/env bun
/**
 * daily-journal.ts — deterministic wrapper for the daily-journal cron.
 *
 * Why this exists: the original cron prompt let the LLM do everything (compose
 * journal, write file, tg-send digest, update Last run). The Last-run + tg
 * steps were intermittently skipped (e.g. 2026-05-02, 2026-05-03), so the
 * journal made it to Obsidian but the user never saw the notification.
 *
 * This wrapper does file I/O, tg-send, and conversation logging
 * deterministically. The LLM only composes the journal markdown + a 3–5 line
 * Telegram digest. cron-daemon reads the script's final stdout line into
 * CRON.md's Last run.
 *
 * Usage:
 *   bun run bin/daily-journal.ts            # generate today's journal
 *   bun run bin/daily-journal.ts 2026-05-03 # backfill for a specific date
 *   bun run bin/daily-journal.ts --dry-run  # compose, write, but skip tg-send
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import {
  etDateAndHm,
  runClaude,
  tgSend,
  logToConversation,
  defaultChatId,
} from "./lib/cron-helpers";
import { readEmailLog } from "./lib/email-log";

const ROOT = resolve(import.meta.dir, "..");
const VAULT = process.env.VAULT_PATH;
if (!VAULT) {
  console.error("VAULT_PATH is required (set in .env)");
  process.exit(1);
}
const CHAT_ID = defaultChatId();

// Per-day idempotency sentinel. The cron fires a `claude -p` session whose only
// job is to run this script; that session occasionally invokes us TWICE (a
// double Bash tool-call), and each invocation composes fresh + sends — so the
// user gets two near-identical digests minutes apart (observed 2026-06-24).
// We record the last date whose digest was sent; a second run for the same date
// is a no-op. Bypass with --force (used for deliberate re-runs / backfills).
const SENT_SENTINEL = resolve(ROOT, "data/daily-journal-sent.json");

function alreadySent(date: string): boolean {
  if (!existsSync(SENT_SENTINEL)) return false;
  try {
    return JSON.parse(readFileSync(SENT_SENTINEL, "utf8")).date === date;
  } catch {
    return false;
  }
}

function markSent(date: string): void {
  try {
    writeFileSync(SENT_SENTINEL, JSON.stringify({ date, at: new Date().toISOString() }));
  } catch (err) {
    console.error("failed to write sent-sentinel:", (err as Error).message);
  }
}

interface JournalResult {
  full_md: string;
  digest_body: string;
}

/**
 * Parse LLM output framed as:
 *   ===DIGEST===
 *   <body>
 *   ===JOURNAL===
 *   <body>
 *   ===END===
 *
 * Plain delimiters dodge JSON escape pain (newlines/quotes inside markdown
 * make extractJson brittle).
 */
function parseFramed(text: string): JournalResult {
  const dIdx = text.indexOf("===DIGEST===");
  const jIdx = text.indexOf("===JOURNAL===");
  const eIdx = text.indexOf("===END===");
  if (dIdx < 0 || jIdx < 0 || eIdx < 0 || !(dIdx < jIdx && jIdx < eIdx)) {
    throw new Error(`framed markers missing/out-of-order in:\n${text.slice(0, 600)}`);
  }
  const digest_body = text.slice(dIdx + "===DIGEST===".length, jIdx).trim();
  const full_md = text.slice(jIdx + "===JOURNAL===".length, eIdx).trim();
  return { digest_body, full_md };
}

function parseArgs(argv: string[]): { date: string; dryRun: boolean; force: boolean } {
  let date = etDateAndHm().date;
  let dryRun = false;
  let force = false;
  for (const a of argv) {
    if (a === "--dry-run") dryRun = true;
    else if (a === "--force") force = true;
    else if (/^\d{4}-\d{2}-\d{2}$/.test(a)) date = a;
  }
  return { date, dryRun, force };
}

async function compose(date: string): Promise<JournalResult> {
  const convPath = resolve(ROOT, `data/conversations/${date}.md`);
  const journalPath = resolve(VAULT!, `kb/areas/journal/${date}.md`);
  const cutoffUnix = Math.floor(new Date(`${date}T00:00:00`).getTime() / 1000);

  // Prefer the email log the gmail-digest cron already wrote today (drop/keep
  // class + gists) — no second Gmail round-trip. Fall back to a live Gmail
  // search only when the log is empty (digest didn't run / backfilling an old
  // date). We embed the log text straight into the prompt so the LLM doesn't
  // need a tool call for the common path.
  const emailEntries = readEmailLog(date);
  const emailSource = emailEntries.length
    ? `3. Email is ALREADY collected for you below (from the gmail-digest cron's daily log — do NOT call any Gmail tool). Each entry is one email the digest handled today; cls "keep" = important (has gist/suggestion), cls "drop" = unimportant (promo/automated, auto-archived, has a short reason tag).
Email log (${emailEntries.length} entries):
${JSON.stringify(emailEntries)}
In the journal's ## Notes section add an "邮件" sub-summary: list the "keep" mail individually (sender + its gist), then ONE rolled-up line bucketing the "drop" mail (e.g. "其余 N 封自动/促销: Amazon 促销、学校 PTA 推送、USPS 投递…"). Don't drop the unimportant ones — bucket them.`
    : `3. The digest log is empty for today, so search Gmail yourself: mcp__gmail__search_emails query "after:${cutoffUnix}" maxResults 50 — recap ALL of today's email, including promos/automated/archived ones (the search hits All Mail, so archived mail still shows). In the journal's ## Notes section add an "邮件" sub-summary: list important work/personal mail individually (sender + what it was), then ONE rolled-up line for the unimportant bulk. Don't drop the unimportant ones — bucket them.`;

  const prompt = `You are a non-interactive helper. Today's journal generator. Output ONLY the framed sections at the end — no prose before, no commentary, no markdown fences around the markers.

Date: ${date}
Conversation log: ${convPath}
Journal file (existing or to create): ${journalPath}

Steps (do all, in order):

1. Read the conversation log at ${convPath} (use Read tool). It contains today's Telegram conversations between the user and the assistant.
2. Check Google Calendar for today's events: call mcp__claude_ai_Google_Calendar__list_events with timeMin="${date}T00:00:00-04:00" and timeMax="${date}T23:59:59-04:00".
${emailSource}
4. Read the existing journal file at ${journalPath} if it exists. You MUST preserve every existing bullet verbatim — only ADD new items, never remove or rewrite existing ones.
5. Compose the FULL file content in Chinese, bullet style, three sections (Work / Personal / Notes). Include specific names, numbers, outcomes — not vague summaries. Group related bullets under the right section. Avoid duplicating bullets that are already in the existing file.
6. Compose a 3–5 line Chinese digest summarizing the most notable items of the day (no leading emoji — the wrapper adds the prefix).

Output exactly this format and nothing else:

===DIGEST===
<3-5 line Chinese digest>
===JOURNAL===
---
tags:
  - journal
date: ${date}
---

# ${date}

## Work
<bullets>

## Personal
<bullets>

## Notes
<bullets>
===END===`;

  const out = await runClaude(prompt, 8 * 60 * 1000);
  return parseFramed(out);
}

async function main(): Promise<void> {
  const { date, dryRun, force } = parseArgs(process.argv.slice(2));
  const journalPath = resolve(VAULT!, `kb/areas/journal/${date}.md`);

  // Idempotency guard: bail before the expensive compose if today's digest was
  // already sent (e.g. a duplicate cron invocation). --force / --dry-run bypass.
  if (!dryRun && !force && alreadySent(date)) {
    console.log(`skipped ${date}: digest already sent today (use --force to re-run)`);
    return;
  }

  let result: JournalResult;
  try {
    result = await compose(date);
  } catch (err) {
    console.error("compose failed:", (err as Error).message);
    process.exit(1);
  }

  if (!result.full_md || !result.digest_body) {
    console.error("LLM output missing fields:", JSON.stringify(result).slice(0, 400));
    process.exit(1);
  }

  if (dryRun) {
    console.log(`[dry-run] would write ${journalPath} (${result.full_md.length} chars)`);
    console.log(`[dry-run] would send digest:\n${result.digest_body}`);
    return;
  }

  // Write journal file (overwrite — LLM was told to merge existing content in).
  if (!existsSync(dirname(journalPath))) mkdirSync(dirname(journalPath), { recursive: true });
  writeFileSync(journalPath, result.full_md);

  // Send tg digest.
  const digest = `📔 今日日记已生成 (${date})\n\n${result.digest_body}`;
  let sent = false;
  try {
    await tgSend(CHAT_ID, digest);
    logToConversation(digest);
    markSent(date);
    sent = true;
  } catch (err) {
    console.error("tg-send failed:", (err as Error).message);
  }

  // Final stdout line — cron-daemon reads this into CRON.md "Last run".
  const rel = journalPath.replace(VAULT!, "").replace(/^\//, "");
  console.log(`merged ${rel} (digest ${sent ? "sent" : "FAILED"})`);
}

main().catch((err) => {
  console.error("daily-journal error:", (err as Error).message);
  process.exit(1);
});
