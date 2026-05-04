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
} from "./lib/cron-helpers";

const ROOT = resolve(import.meta.dir, "..");
const VAULT = process.env.VAULT_PATH;
if (!VAULT) {
  console.error("VAULT_PATH is required (set in .env)");
  process.exit(1);
}
const CHAT_ID = "7504317155";

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

function parseArgs(argv: string[]): { date: string; dryRun: boolean } {
  let date = etDateAndHm().date;
  let dryRun = false;
  for (const a of argv) {
    if (a === "--dry-run") dryRun = true;
    else if (/^\d{4}-\d{2}-\d{2}$/.test(a)) date = a;
  }
  return { date, dryRun };
}

async function compose(date: string): Promise<JournalResult> {
  const convPath = resolve(ROOT, `data/conversations/${date}.md`);
  const journalPath = resolve(VAULT!, `kb/areas/journal/${date}.md`);
  const cutoffUnix = Math.floor(new Date(`${date}T00:00:00`).getTime() / 1000);

  const prompt = `You are a non-interactive helper. Today's journal generator. Output ONLY the framed sections at the end — no prose before, no commentary, no markdown fences around the markers.

Date: ${date}
Conversation log: ${convPath}
Journal file (existing or to create): ${journalPath}

Steps (do all, in order):

1. Read the conversation log at ${convPath} (use Read tool). It contains today's Telegram conversations between Siyun and the assistant.
2. Check Google Calendar for today's events: call mcp__claude_ai_Google_Calendar__list_events with timeMin="${date}T00:00:00-04:00" and timeMax="${date}T23:59:59-04:00".
3. Search Gmail with mcp__gmail__search_emails query "after:${cutoffUnix}" and maxResults 25 — note any work/personal mail worth recording (skip promos/automated).
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
  const { date, dryRun } = parseArgs(process.argv.slice(2));
  const journalPath = resolve(VAULT!, `kb/areas/journal/${date}.md`);

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
