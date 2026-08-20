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
 * Gmail I/O is done directly via the Gmail REST API (bin/lib/gmail-api.ts) —
 * NOT through the @gongrzhe gmail-autoauth MCP server, which each `claude -p`
 * subprocess re-booted via npx and which flaked on its cold-start OAuth
 * handshake (the recurring "search returned 0 / errored" bug). The LLM now only
 * does pure-text reasoning (no tool access), so it can't flake on a tool call.
 *
 * This wrapper does all stateful work + all Gmail I/O deterministically and
 * invokes the LLM in two pure-text passes:
 *   (a) CLASSIFY (haiku): we fetch unread headers directly, then hand the
 *       header list to the LLM to split DROP vs KEEP from sender+subject.
 *   (b) ANALYZE (sonnet): we fetch the new KEEP bodies directly, then hand the
 *       (from/subject/body) text to the LLM for a per-email gist + a one-line
 *       "how to handle" suggestion, and — for time-sensitive mail (interview,
 *       deadline, appointment) — a PROPOSED schedule entry. We do NOT
 *       auto-create calendar/reminder items from a non-interactive cron;
 *       proposals are listed in the digest for the user to confirm.
 *
 * Final stdout line is the 1-line summary that cron-daemon reads back into
 * CRON.md's "Last run".
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import {
  etIsoNow,
  etDateAndHm,
  runClaude,
  extractJson,
  tgSend,
  logToConversation,
  defaultChatId,
} from "./lib/cron-helpers";
import { searchMessageIds, getHeaders, getBody, batchModify } from "./lib/gmail-api";
import { appendEmailLog, type EmailLogEntry } from "./lib/email-log";

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
  // searchOk=false means the Gmail search tool itself errored (auth/MCP flake),
  // which is DIFFERENT from a genuinely empty inbox (searchOk=true, rawCount=0).
  // We must distinguish these so a flake alerts loudly instead of silently
  // reporting "0 new" — the recurring bug this guard exists to fix.
  searchOk: boolean;
  rawCount: number; // raw emails the search returned, before DROP/KEEP split
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

// Pass (a): cheap header-only DROP/KEEP split. We fetch the unread headers
// DIRECTLY via the Gmail REST API (no MCP), then the LLM only reasons over the
// header text — it can't flake on a tool call. searchOk=false now means the
// direct API call itself threw (network/auth), NOT an LLM hiccup.
async function classify(): Promise<ClassifyResult> {
  // Direct Gmail I/O — this replaces the old mcp__gmail__search_emails call.
  let headers: KeepHeader[];
  try {
    const ids = await searchMessageIds("is:unread in:inbox", UNREAD_LIMIT);
    headers = await getHeaders(ids);
  } catch (err) {
    // A genuine direct-API/network/auth failure → outage. The caller alerts.
    throw new Error(`gmail search/headers failed: ${(err as Error).message}`);
  }
  // Empty inbox: skip the LLM entirely, report a clean 0.
  if (headers.length === 0) {
    return { searchOk: true, rawCount: 0, drop: [], keep: [] };
  }

  const prompt = `You are a non-interactive helper. You are given a JSON list of unread Gmail messages (id + sender + subject). Output ONLY the final JSON, no prose, no markdown fences.

Messages:
${JSON.stringify(headers)}

Classify each message into DROP or KEEP using sender + subject ONLY:
- DROP: marketing/promos (sale/deal/%off/newsletter/weekly digest), automated senders (no-reply@, donotreply@, notifications@, *@public.govdelivery.com), USPS Informed Delivery, job alerts, system notifications.
- KEEP: personal/work mail, school teachers/parents, tax/visa/legal, payments needing review, anything from a real person addressed to the user.

For each DROP, also give a "reason": a 2-8 char Chinese tag for WHY it's archived (e.g. 促销/自动推送/job alert/过期通知/账单提醒/新闻摘要).
Use the EXACT id/from/subject values from the input. Every input message must appear in exactly one of "drop" or "keep".

Output ONLY this JSON:
{"drop":[{"id":"msgid","from":"name","subject":"subj","reason":"促销"}],"keep":[{"id":"msgid","from":"name","subject":"subj"}]}`;
  const out = await runClaude(prompt, 90 * 1000, "haiku");
  const r = extractJson<Partial<ClassifyResult>>(out);
  const drop = Array.isArray(r.drop) ? r.drop : [];
  const keep = Array.isArray(r.keep) ? r.keep : [];
  return {
    // Search already succeeded above (we got headers); this pass is pure text.
    searchOk: true,
    rawCount: headers.length,
    drop,
    keep,
  };
}

// Run classify up to 3 times to ride out a transient direct-API/network hiccup
// or an unparseable LLM classification. Return as soon as we get real data;
// otherwise return the last result so the caller can tell a hard outage
// (searchOk=false) from a true empty inbox.
async function classifyWithRetry(): Promise<ClassifyResult> {
  let last: ClassifyResult = { searchOk: false, rawCount: 0, drop: [], keep: [] };
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await classify();
      last = r;
      if (r.searchOk && r.rawCount > 0) return r; // got real data → done
      console.error(
        `classify attempt ${attempt}/3: searchOk=${r.searchOk} rawCount=${r.rawCount} — retrying`,
      );
    } catch (err) {
      console.error(`classify attempt ${attempt}/3 threw:`, (err as Error).message);
      last = { searchOk: false, rawCount: 0, drop: [], keep: [] };
    }
  }
  return last;
}

// Pass (b): read the bodies of the (already deduped) KEEP mail and produce a
// gist + handling suggestion + optional schedule proposal. Reasoning task →
// sonnet. Only called when there is new KEEP mail, so cost scales with signal.
async function analyzeKeep(keep: KeepHeader[]): Promise<AnalyzeResult> {
  // Fetch the bodies DIRECTLY via the Gmail REST API (no MCP), then hand the
  // text to the LLM. If a single body fetch fails, degrade that one to its
  // header so one bad message doesn't sink the whole analyze pass.
  const emails = await Promise.all(
    keep.map(async (k) => {
      try {
        const b = await getBody(k.id);
        return { id: k.id, from: b.from || k.from, subject: b.subject || k.subject, body: b.body };
      } catch (err) {
        console.error(`getBody ${k.id} failed:`, (err as Error).message);
        return { id: k.id, from: k.from, subject: k.subject, body: "(无法读取正文)" };
      }
    }),
  );
  const prompt = `You are a non-interactive helper analysing the user's important unread email. Output ONLY the final JSON, no prose, no markdown fences.

You are given a JSON list of emails (id + from + subject + body):
${JSON.stringify(emails)}

For EACH email produce:
   - "gist": one Chinese sentence (<=60 chars) — what this email is actually about (from the body, not just the subject).
   - "suggestion": one short Chinese sentence — what the user should do about it (回复/缴费/确认/无需处理/存档 etc). Be concrete.
   - "schedule": if and ONLY if the email contains a concrete date/time the user should act on (interview slot, appointment, deadline, due date, meeting), an object {"title":"...","when":"YYYY-MM-DD HH:MM or best human form","kind":"event"|"reminder"}. Use "event" for things at a fixed time (meeting/interview/appointment), "reminder" for deadlines. If there is no actionable time, set "schedule": null.

Use the EXACT id/from/subject values from the input.
Output ONLY this JSON:
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
  // Direct Gmail REST call — no MCP, no claude spawn.
  try {
    await batchModify(ids, [], ["UNREAD", "INBOX"]);
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

  const classified = await classifyWithRetry();

  // Hard outage: search errored on every retry. Alert LOUDLY instead of silently
  // reporting "0 new" — a silent 0 here is the exact bug we're fixing. A genuinely
  // empty inbox (searchOk=true, rawCount=0) falls through and reports 0 normally.
  if (!classified.searchOk) {
    const warn =
      "⚠️ Gmail 简报这轮没跑成:连不上 Gmail(auth/MCP 抽风),已重试 3 次还是失败,本轮跳过。\n如果连着几轮都这样,戳我重新授权 Gmail。";
    try {
      await tgSend(CHAT_ID, warn);
      logToConversation(warn);
    } catch (err) {
      console.error("outage-alert tg-send failed:", (err as Error).message);
    }
    console.log("0 new, 0 archived (gmail unreachable)");
    return;
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

  // Append everything we processed this run to the day's email log so the
  // daily-journal cron can recap the full day without a second Gmail search.
  // drops are always fresh (archived → never re-seen); keepNew is deduped — so
  // these lines can't duplicate across runs within a day.
  const logTs = etIsoNow();
  const logEntries: EmailLogEntry[] = [
    ...drops.map((d) => ({
      ts: logTs,
      from: d.from,
      subject: d.subject,
      cls: "drop" as const,
      reason: d.reason,
    })),
    ...keepNew.map((k) => {
      const a = items.find((it) => it.id === k.id);
      return {
        ts: logTs,
        from: k.from,
        subject: k.subject,
        cls: "keep" as const,
        gist: a?.gist,
        suggestion: a?.suggestion,
      };
    }),
  ];
  appendEmailLog(etDateAndHm().date, logEntries);

  // Only ping Telegram when there's important mail to surface. Per user
  // (2026-06-15): if a run only archived promos/automated mail, stay SILENT —
  // no "📭 没有要紧的未读邮件" message. Archiving still happened above; the
  // daily journal recaps everything (incl. archived) via its own Gmail search.
  // When we DO send (keepNew>0), the footer still lists what was archived.
  let sent = 0;
  if (keepNew.length > 0) {
    const ok = await sendDigest(items, drops);
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
  console.log(`${sent} new, ${drops.length} archived`);
}

main().catch((err) => {
  console.error("gmail-digest error:", (err as Error).message);
  process.exit(1);
});
