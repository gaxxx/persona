#!/usr/bin/env bun
/**
 * gmail-digest.ts — deterministic wrapper for the gmail-unread-digest cron.
 *
 * Why this exists: the original cron prompt let the LLM do everything (search,
 * dedup, mark-read, send, persist). Two failure modes emerged:
 *   1. `newer_than:35m` was misread by Gmail (`m` = months, not minutes), so
 *      ancient emails leaked into the digest. We use `after:<unix>` instead.
 *   2. The LLM intermittently skipped step 5 (filter against gmail-notified.json)
 *      and step 8 (persist), leading to repeated notifications.
 *
 * This wrapper does all stateful work deterministically and only invokes the
 * LLM for: (a) classify DROP vs KEEP, (b) one-line Chinese gist per KEEP.
 *
 * Final stdout line is the 1-line summary that cron-daemon reads back into
 * CRON.md's "Last run".
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import {
  etIsoNow,
  runClaude,
  extractJson,
  tgSend,
  logToConversation,
} from "./lib/cron-helpers";

const ROOT = resolve(import.meta.dir, "..");
const VAULT = process.env.VAULT_PATH;
if (!VAULT) {
  console.error("VAULT_PATH is required (set in .env)");
  process.exit(1);
}

const DEDUP_PATH = resolve(ROOT, "data/gmail-notified.json");
const CHAT_ID = "7504317155";
const WINDOW_MIN = 60;
const PRUNE_DAYS = 7;

type DedupState = Record<string, string>;

function loadDedup(): DedupState {
  if (!existsSync(DEDUP_PATH)) return {};
  try {
    return JSON.parse(readFileSync(DEDUP_PATH, "utf8")) as DedupState;
  } catch {
    return {};
  }
}

function pruneDedup(state: DedupState): DedupState {
  const cutoff = Date.now() - PRUNE_DAYS * 24 * 3600 * 1000;
  const pruned: DedupState = {};
  for (const [id, ts] of Object.entries(state)) {
    const t = new Date(ts).getTime();
    if (Number.isFinite(t) && t > cutoff) pruned[id] = ts;
  }
  return pruned;
}

function saveDedup(state: DedupState): void {
  if (!existsSync(dirname(DEDUP_PATH))) mkdirSync(dirname(DEDUP_PATH), { recursive: true });
  writeFileSync(DEDUP_PATH, JSON.stringify(state, null, 2));
}

interface KeepItem {
  id: string;
  from: string;
  subject: string;
  gist: string;
}
interface ClassifyResult {
  drop_ids: string[];
  keep: KeepItem[];
}

async function classifyAndSummarize(cutoffUnix: number): Promise<ClassifyResult> {
  const prompt = `You are a non-interactive helper. Run the steps and output ONLY the final JSON.

1. Call mcp__gmail__search_emails with query "is:unread after:${cutoffUnix}" and maxResults 25.
2. Classify each result into DROP or KEEP using sender + subject (do NOT fetch each email):
   - DROP: marketing/promos (sale/deal/%off/newsletter/weekly digest), automated senders (no-reply@, donotreply@, notifications@, *@public.govdelivery.com), USPS Informed Delivery, job alerts, system notifications.
   - KEEP: personal/work mail, school teachers/parents, tax/visa/legal, payments needing review, anything from a real person addressed to Siyun.
3. For each KEEP, write a single-sentence Chinese gist (<=80 chars). Use the subject + sender to infer; do not fetch the body.
4. Output ONLY this JSON, no prose, no markdown fences:
{"drop_ids": ["msgid", ...], "keep": [{"id":"msgid","from":"name","subject":"subj","gist":"中文简介"}]}

If search returns nothing, output: {"drop_ids":[],"keep":[]}`;
  const out = await runClaude(prompt);
  return extractJson<ClassifyResult>(out);
}

async function markRead(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const prompt = `Call mcp__gmail__batch_modify_emails with messageIds=${JSON.stringify(
    ids,
  )} and removeLabelIds=["UNREAD"]. Then output "OK" and stop. Do nothing else.`;
  try {
    await runClaude(prompt, 90 * 1000);
  } catch (err) {
    console.error("mark-read failed:", (err as Error).message);
  }
}

async function sendDigest(keep: KeepItem[]): Promise<boolean> {
  const lines = keep.map((k) => `• ${k.from} — ${k.subject} — ${k.gist}`);
  const digest = `📬 邮件摘要 (${keep.length} 封):\n\n${lines.join("\n")}`;
  try {
    await tgSend(CHAT_ID, digest);
  } catch (err) {
    console.error("tg-send failed:", (err as Error).message);
    return false;
  }
  logToConversation(digest);
  return true;
}

async function main(): Promise<void> {
  const dedup = pruneDedup(loadDedup());
  saveDedup(dedup);

  const cutoffUnix = Math.floor((Date.now() - WINDOW_MIN * 60 * 1000) / 1000);

  let result: ClassifyResult;
  try {
    result = await classifyAndSummarize(cutoffUnix);
  } catch (err) {
    console.error("classify failed:", (err as Error).message);
    process.exit(1);
  }

  const dropIds = Array.isArray(result.drop_ids) ? result.drop_ids : [];
  const keepRaw = Array.isArray(result.keep) ? result.keep : [];
  const keepFiltered = keepRaw.filter((k) => k && k.id && !(k.id in dedup));

  await markRead(dropIds);

  let sent = 0;
  if (keepFiltered.length > 0) {
    const ok = await sendDigest(keepFiltered);
    if (ok) {
      const ts = etIsoNow();
      for (const k of keepFiltered) dedup[k.id] = ts;
      saveDedup(dedup);
      sent = keepFiltered.length;
    }
  }

  // Final stdout line — cron-daemon reads this into CRON.md "Last run".
  console.log(`${sent} new, ${dropIds.length} auto-read`);
}

main().catch((err) => {
  console.error("gmail-digest error:", (err as Error).message);
  process.exit(1);
});
