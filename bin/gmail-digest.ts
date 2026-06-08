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
 * This wrapper does all stateful work deterministically and invokes the LLM in
 * two passes:
 *   (a) CLASSIFY (haiku, headers only): split DROP vs KEEP from sender+subject.
 *   (b) ANALYZE (sonnet, reads bodies of the new KEEP mail): per-email gist +
 *       a one-line "how to handle" suggestion, and — for time-sensitive mail
 *       (interview, deadline, appointment) — a PROPOSED schedule entry. We do
 *       NOT auto-create calendar/reminder items from a non-interactive cron;
 *       proposals are listed in the digest for the user to confirm.
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
  defaultChatId,
} from "./lib/cron-helpers";

const ROOT = resolve(import.meta.dir, "..");
const VAULT = process.env.VAULT_PATH;
if (!VAULT) {
  console.error("VAULT_PATH is required (set in .env)");
  process.exit(1);
}

const DEDUP_PATH = resolve(ROOT, "data/gmail-notified.json");
const CHAT_ID = defaultChatId();
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

interface KeepHeader {
  id: string;
  from: string;
  subject: string;
}
interface ClassifyResult {
  drop_ids: string[];
  keep: KeepHeader[];
}

interface ScheduleProposal {
  title: string; // short event/reminder title
  when: string; // human-readable date/time, e.g. "2026-06-10 14:00" or "周二下午"
  kind: "event" | "reminder"; // calendar event vs a simple reminder
}
interface AnalyzedItem {
  id: string;
  from: string;
  subject: string;
  gist: string; // 一句话:这封邮件是关于什么
  suggestion: string; // 一句话:建议怎么处理
  schedule: ScheduleProposal | null; // 仅当邮件含明确时间/截止/预约
}
interface AnalyzeResult {
  items: AnalyzedItem[];
}

// Pass (a): cheap header-only DROP/KEEP split. No body fetch → safe on haiku.
async function classify(cutoffUnix: number): Promise<ClassifyResult> {
  const prompt = `You are a non-interactive helper. Run the steps and output ONLY the final JSON.

1. Call mcp__gmail__search_emails with query "is:unread after:${cutoffUnix}" and maxResults 25.
2. Classify each result into DROP or KEEP using sender + subject ONLY (do NOT fetch any email body):
   - DROP: marketing/promos (sale/deal/%off/newsletter/weekly digest), automated senders (no-reply@, donotreply@, notifications@, *@public.govdelivery.com), USPS Informed Delivery, job alerts, system notifications.
   - KEEP: personal/work mail, school teachers/parents, tax/visa/legal, payments needing review, anything from a real person addressed to the user.
3. Output ONLY this JSON, no prose, no markdown fences:
{"drop_ids": ["msgid", ...], "keep": [{"id":"msgid","from":"name","subject":"subj"}]}

If search returns nothing, output: {"drop_ids":[],"keep":[]}`;
  const out = await runClaude(prompt, 90 * 1000, "haiku");
  return extractJson<ClassifyResult>(out);
}

// Pass (b): read the bodies of the (already deduped) KEEP mail and produce a
// gist + handling suggestion + optional schedule proposal. Reasoning task →
// sonnet. Only called when there is new KEEP mail, so cost scales with signal.
async function analyzeKeep(keep: KeepHeader[]): Promise<AnalyzeResult> {
  const ids = keep.map((k) => k.id);
  const prompt = `You are a non-interactive helper analysing the user's important unread email. Output ONLY the final JSON.

These Gmail message IDs are mail worth reading: ${JSON.stringify(ids)}.

For EACH id:
1. Call mcp__gmail__read_email to fetch the body.
2. Produce:
   - "gist": one Chinese sentence (<=60 chars) — what this email is actually about (from the body, not just the subject).
   - "suggestion": one short Chinese sentence — what the user should do about it (回复/缴费/确认/无需处理/存档 etc). Be concrete.
   - "schedule": if and ONLY if the email contains a concrete date/time the user should act on (interview slot, appointment, deadline, due date, meeting), an object {"title":"...","when":"YYYY-MM-DD HH:MM or best human form","kind":"event"|"reminder"}. Use "event" for things at a fixed time (meeting/interview/appointment), "reminder" for deadlines. If there is no actionable time, set "schedule": null.

Output ONLY this JSON, no prose, no markdown fences:
{"items":[{"id":"msgid","from":"name","subject":"subj","gist":"...","suggestion":"...","schedule":null}]}`;
  const out = await runClaude(prompt, 4 * 60 * 1000, "sonnet");
  return extractJson<AnalyzeResult>(out);
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

function renderDigest(items: AnalyzedItem[]): string {
  const blocks = items.map((it, i) => {
    const parts = [
      `${i + 1}. ${it.from} — ${it.subject}`,
      `   📄 ${it.gist}`,
      `   💡 ${it.suggestion}`,
    ];
    if (it.schedule) {
      const tag = it.schedule.kind === "event" ? "日历" : "提醒";
      parts.push(`   📅 建议${tag}:「${it.schedule.title}」@ ${it.schedule.when}`);
    }
    return parts.join("\n");
  });
  let digest = `📬 邮件简报 (${items.length} 封值得看):\n\n${blocks.join("\n\n")}`;
  if (items.some((it) => it.schedule)) {
    digest += `\n\n回复「建日程」我就把上面带 📅 的加到日历/提醒。`;
  }
  return digest;
}

async function sendDigest(items: AnalyzedItem[]): Promise<boolean> {
  const digest = renderDigest(items);
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

  let classified: ClassifyResult;
  try {
    classified = await classify(cutoffUnix);
  } catch (err) {
    console.error("classify failed:", (err as Error).message);
    process.exit(1);
  }

  const dropIds = Array.isArray(classified.drop_ids) ? classified.drop_ids : [];
  const keepRaw = Array.isArray(classified.keep) ? classified.keep : [];
  // Dedup BEFORE the expensive analyze pass — only read bodies of new mail.
  const keepNew = keepRaw.filter((k) => k && k.id && !(k.id in dedup));

  await markRead(dropIds);

  let sent = 0;
  if (keepNew.length > 0) {
    let items: AnalyzedItem[];
    try {
      const analyzed = await analyzeKeep(keepNew);
      items = Array.isArray(analyzed.items) ? analyzed.items : [];
    } catch (err) {
      console.error("analyze failed:", (err as Error).message);
      // Degrade gracefully: send a header-only digest so mail isn't silently lost.
      items = keepNew.map((k) => ({
        id: k.id,
        from: k.from,
        subject: k.subject,
        gist: "(正文分析失败,仅标题)",
        suggestion: "手动打开看看",
        schedule: null,
      }));
    }
    const ok = await sendDigest(items);
    if (ok) {
      const ts = etIsoNow();
      // Persist every new KEEP id we just surfaced (use the classify list so a
      // dropped/merged id in analyze output can't resurface next run).
      for (const k of keepNew) dedup[k.id] = ts;
      saveDedup(dedup);
      sent = keepNew.length;
    }
  }

  // Final stdout line — cron-daemon reads this into CRON.md "Last run".
  console.log(`${sent} new, ${dropIds.length} auto-read`);
}

main().catch((err) => {
  console.error("gmail-digest error:", (err as Error).message);
  process.exit(1);
});
