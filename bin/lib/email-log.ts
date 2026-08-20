/**
 * email-log.ts — shared daily email log written by the gmail-digest cron and
 * read by the daily-journal cron.
 *
 * Why: both crons used to hit the Gmail API independently — the digest to
 * classify/analyze unread mail, the journal to re-search the same day's mail.
 * That's a duplicate Gmail round-trip AND duplicate LLM classification. Instead
 * the digest (which already classifies DROP/KEEP and gists the KEEP bodies)
 * appends what it processed each run to data/email-log/<YYYY-MM-DD>.jsonl, and
 * the journal just reads that file. One source of truth, no second API call.
 *
 * Format: one JSON object per line (JSONL — append-only, robust to partial
 * writes). Each entry is one email the digest handled that run:
 *   keep: {"ts","from","subject","cls":"keep","gist","suggestion"}
 *   drop: {"ts","from","subject","cls":"drop","reason"}
 *
 * Dedup is implicit: DROP mail is archived (never re-seen), KEEP mail is
 * deduped against gmail-notified.json before the digest logs it — so appending
 * each run's drops + new keeps can't produce duplicate lines within a day.
 */
import { existsSync, readFileSync, appendFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";

const ROOT = resolve(import.meta.dir, "..", "..");

export interface EmailLogEntry {
  ts: string;
  from: string;
  subject: string;
  cls: "keep" | "drop";
  gist?: string;
  suggestion?: string;
  reason?: string;
}

export function emailLogPath(date: string): string {
  return resolve(ROOT, `data/email-log/${date}.jsonl`);
}

export function appendEmailLog(date: string, entries: EmailLogEntry[]): void {
  if (entries.length === 0) return;
  const path = emailLogPath(date);
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  const lines = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  appendFileSync(path, lines);
}

export function readEmailLog(date: string): EmailLogEntry[] {
  const path = emailLogPath(date);
  if (!existsSync(path)) return [];
  const out: EmailLogEntry[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as EmailLogEntry);
    } catch {
      // Skip a corrupt/partial line rather than sink the whole read.
    }
  }
  return out;
}
