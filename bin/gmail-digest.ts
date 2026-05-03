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
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from "fs";
import { resolve, dirname } from "path";

const ROOT = resolve(import.meta.dir, "..");
const VAULT = process.env.VAULT_PATH;
if (!VAULT) {
  console.error("VAULT_PATH is required (set in .env)");
  process.exit(1);
}

const DEDUP_PATH = resolve(ROOT, "data/gmail-notified.json");
const CRON_PATH = resolve(VAULT, "persona/CRON.md");
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

function etIsoNow(): string {
  // 2026-05-03T14:23-04:00 (system local TZ assumed to be ET — see CRON.md)
  const d = new Date();
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  const local = new Date(d.getTime() + offsetMin * 60000)
    .toISOString()
    .slice(0, 16);
  return `${local}${sign}${hh}:${mm}`;
}

function etDateAndHm(): { date: string; hm: string } {
  const iso = etIsoNow();
  return { date: iso.slice(0, 10), hm: iso.slice(11, 16) };
}

async function runClaude(prompt: string, timeoutMs = 5 * 60 * 1000): Promise<string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) continue;
    if (typeof v === "string") env[k] = v;
  }
  const proc = Bun.spawn(
    ["claude", "-p", prompt, "--permission-mode", "bypassPermissions"],
    {
      cwd: ROOT,
      env,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    },
  );
  const timeout = setTimeout(() => proc.kill(), timeoutMs);
  const exitCode = await proc.exited;
  clearTimeout(timeout);
  const stdout = await new Response(proc.stdout).text();
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`claude exit=${exitCode} stderr=${stderr.slice(-400)}`);
  }
  return stdout.trim();
}

function extractJson<T>(text: string): T {
  // Match the outermost { ... } block. Greedy match handles nested arrays/objects.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(`No JSON object in output:\n${text.slice(0, 400)}`);
  }
  return JSON.parse(text.slice(start, end + 1)) as T;
}

function updateCronLastRun(taskId: string, suffix: string): void {
  if (!existsSync(CRON_PATH)) return;
  const content = readFileSync(CRON_PATH, "utf8");
  // Match "## <taskId>" then the FIRST "- **Last run:** <stuff till EOL>" within that section.
  const re = new RegExp(
    `(## ${taskId}[\\s\\S]*?- \\*\\*Last run:\\*\\*)[^\\n]*`,
  );
  if (!re.test(content)) return;
  const next = content.replace(re, `$1 ${etIsoNow()} ${suffix}`);
  writeFileSync(CRON_PATH, next);
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
  const lines = keep.map(
    (k) => `• ${k.from} — ${k.subject} — ${k.gist}`,
  );
  const digest = `📬 邮件摘要 (${keep.length} 封):\n\n${lines.join("\n")}`;
  const proc = Bun.spawn(
    ["bun", "run", resolve(ROOT, "bin/tg-send.ts"), CHAT_ID, digest],
    { cwd: ROOT, stdout: "pipe", stderr: "pipe", stdin: "ignore" },
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    console.error("tg-send failed:", stderr);
    return false;
  }
  // Log to today's conversation
  const { date, hm } = etDateAndHm();
  const logPath = resolve(ROOT, `data/conversations/${date}.md`);
  if (!existsSync(dirname(logPath))) mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, `\n[${hm}] bot: ${digest.replace(/\n/g, " ")}\n`);
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

  updateCronLastRun(
    "gmail-unread-digest",
    `— ${sent} new, ${dropIds.length} auto-read`,
  );

  console.log(
    JSON.stringify({
      ok: true,
      sent,
      dropped: dropIds.length,
      dedup_filtered: keepRaw.length - keepFiltered.length,
    }),
  );
}

main().catch((err) => {
  console.error("gmail-digest error:", (err as Error).message);
  process.exit(1);
});
