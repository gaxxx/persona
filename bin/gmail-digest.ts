#!/usr/bin/env bun
/**
 * gmail-digest.ts — deterministic wrapper for the gmail-unread-digest cron.
 *
 * Why this exists: the original cron prompt let the LLM do everything (search,
 * dedup, archive, send, persist). Two failure modes emerged:
 *   1. `newer_than:35m` was misread by Gmail (`m` = months, not minutes), so
 *      ancient emails leaked into the digest.
 *   2. The LLM intermittently skipped step 5 (filter against gmail-notified.json)
 *      and step 8 (persist), leading to repeated notifications.
 *
 * Scope: we process the latest 50 unread inbox emails (not a time window).
 * DROP mail (promos/automated) is ARCHIVED (INBOX + UNREAD removed) so it
 * leaves the inbox and never re-surfaces — but archiving is NOT silent: the
 * digest footer lists what was archived (sender + subject + a one-line reason)
 * so the user can spot a misfire. KEEP mail stays and is deduped against
 * gmail-notified.json so it's only digested once. We still classify DROP from
 * headers only (no body fetch) — bodies are read for KEEP mail only.
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
// Process the latest N unread inbox emails per run. Default 50; override with
// `bun run bin/gmail-digest.ts <N>` or GMAIL_DIGEST_LIMIT=<N> when a backlog
// needs a bigger sweep. The cron invokes this same script, so it uses 50 too.
const UNREAD_LIMIT = (() => {
  const raw = process.argv[2] ?? process.env.GMAIL_DIGEST_LIMIT;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 50;
})();
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
interface DropHeader {
  id: string;
  from: string;
  subject: string;
  reason: string; // 一句话(2-8字)为什么归档:促销/自动推送/job alert/过期通知...
}
interface ClassifyResult {
  drop: DropHeader[];
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
async function classify(): Promise<ClassifyResult> {
  const prompt = `You are a non-interactive helper. Run the steps and output ONLY the final JSON.

1. Call mcp__gmail__search_emails with query "is:unread in:inbox" and maxResults ${UNREAD_LIMIT}.
2. Classify each result into DROP or KEEP using sender + subject ONLY (do NOT fetch any email body):
   - DROP: marketing/promos (sale/deal/%off/newsletter/weekly digest), automated senders (no-reply@, donotreply@, notifications@, *@public.govdelivery.com), USPS Informed Delivery, job alerts, system notifications.
   - KEEP: personal/work mail, school teachers/parents, tax/visa/legal, payments needing review, anything from a real person addressed to the user.
3. For each DROP, also give a "reason": a 2-8 char Chinese tag for WHY it's archived (e.g. 促销/自动推送/job alert/过期通知/账单提醒/新闻摘要).
4. Output ONLY this JSON, no prose, no markdown fences:
{"drop": [{"id":"msgid","from":"name","subject":"subj","reason":"促销"}], "keep": [{"id":"msgid","from":"name","subject":"subj"}]}

If search returns nothing, output: {"drop":[],"keep":[]}`;
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
  // One retry: the analyze pass reads bodies and occasionally returns
  // unparseable output (model appends a prose note, truncates, etc.). A blank
  // "(正文分析失败)" digest is bad UX, so re-run once before giving up — the
  // caller's catch still degrades gracefully if both attempts fail.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = await runClaude(prompt, 4 * 60 * 1000, "sonnet");
    try {
      return extractJson<AnalyzeResult>(out);
    } catch (err) {
      lastErr = err;
      console.error(`analyze parse failed (attempt ${attempt + 1}/2):`, (err as Error).message);
    }
  }
  throw lastErr;
}

// Archive the DROP mail: remove both INBOX (moves out of inbox) and UNREAD
// (marks read). Recoverable from All Mail if a keep is ever misclassified.
async function archiveDrops(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const prompt = `Call mcp__gmail__batch_modify_emails with messageIds=${JSON.stringify(
    ids,
  )} and removeLabelIds=["UNREAD","INBOX"]. Then output "OK" and stop. Do nothing else.`;
  try {
    await runClaude(prompt, 90 * 1000);
  } catch (err) {
    console.error("archive-drops failed:", (err as Error).message);
  }
}

const ARCHIVED_CAP = 25; // cap the archived list so a big sweep doesn't flood Telegram

function renderArchived(drops: DropHeader[]): string {
  if (drops.length === 0) return "";
  const shown = drops.slice(0, ARCHIVED_CAP);
  const lines = shown.map((d) => `· ${d.from} — ${d.subject}${d.reason ? ` (${d.reason})` : ""}`);
  let s = `\n\n🗑️ 已归档 ${drops.length} 封（移出收件箱，All Mail 可找回）:\n${lines.join("\n")}`;
  if (drops.length > ARCHIVED_CAP) s += `\n…还有 ${drops.length - ARCHIVED_CAP} 封`;
  return s;
}

function renderDigest(items: AnalyzedItem[], drops: DropHeader[]): string {
  let digest: string;
  if (items.length > 0) {
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
    digest = `📬 邮件简报 (${items.length} 封值得看):\n\n${blocks.join("\n\n")}`;
    if (items.some((it) => it.schedule)) {
      digest += `\n\n回复「建日程」我就把上面带 📅 的加到日历/提醒。`;
    }
  } else {
    digest = `📭 没有要紧的未读邮件。`;
  }
  digest += renderArchived(drops);
  return digest;
}

async function sendDigest(items: AnalyzedItem[], drops: DropHeader[]): Promise<boolean> {
  const digest = renderDigest(items, drops);
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

  let classified: ClassifyResult;
  try {
    classified = await classify();
  } catch (err) {
    console.error("classify failed:", (err as Error).message);
    process.exit(1);
  }

  const drops = (Array.isArray(classified.drop) ? classified.drop : []).filter(
    (d) => d && d.id,
  );
  const keepRaw = Array.isArray(classified.keep) ? classified.keep : [];
  // Dedup BEFORE the expensive analyze pass — only read bodies of new mail.
  const keepNew = keepRaw.filter((k) => k && k.id && !(k.id in dedup));

  await archiveDrops(drops.map((d) => d.id));

  // Analyze KEEP bodies (only when there's new important mail).
  let items: AnalyzedItem[] = [];
  if (keepNew.length > 0) {
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
  }

  // Send a digest if there's either important mail to surface OR something was
  // archived — archiving is never silent (option B: list what was archived).
  let sent = 0;
  if (keepNew.length > 0 || drops.length > 0) {
    const ok = await sendDigest(items, drops);
    if (ok && keepNew.length > 0) {
      const ts = etIsoNow();
      // Persist every new KEEP id we just surfaced (use the classify list so a
      // dropped/merged id in analyze output can't resurface next run).
      for (const k of keepNew) dedup[k.id] = ts;
      saveDedup(dedup);
      sent = keepNew.length;
    }
  }

  // Final stdout line — cron-daemon reads this into CRON.md "Last run".
  console.log(`${sent} new, ${drops.length} archived`);
}

main().catch((err) => {
  console.error("gmail-digest error:", (err as Error).message);
  process.exit(1);
});
