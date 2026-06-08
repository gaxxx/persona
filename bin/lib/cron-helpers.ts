/**
 * cron-helpers.ts — shared utilities for deterministic cron task wrappers.
 *
 * Pattern: each cron task lives at bin/<task>.ts. The script does the
 * stateful/deterministic parts itself (file I/O, dedup, tg-send) and only
 * shells out to `claude -p` for the LLM-only parts (classify, summarize,
 * compose). The cron-daemon owns Last-run updates by reading the script's
 * final stdout line.
 */
import { existsSync, mkdirSync, appendFileSync } from "fs";
import { resolve, dirname } from "path";
import { sendMessage } from "./telegram";
import { userDateAndHm } from "./user-tz";

const ROOT = resolve(import.meta.dir, "../..");

export function etIsoNow(): string {
  // 2026-05-04T00:55-04:00 (system local TZ assumed to be ET — see CRON.md)
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

export function etDateAndHm(): { date: string; hm: string } {
  // Honors USER.md Timezone (falls back to system local). Name kept for
  // backwards compat — "et" is now a misnomer when the user travels.
  return userDateAndHm();
}

export async function runClaude(
  prompt: string,
  timeoutMs = 5 * 60 * 1000,
  model?: string,
): Promise<string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) continue;
    if (typeof v === "string") env[k] = v;
  }
  const proc = Bun.spawn(
    [
      "claude",
      "-p",
      prompt,
      "--permission-mode",
      "bypassPermissions",
      ...(model ? ["--model", model] : []),
    ],
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

export function extractJson<T>(text: string): T {
  // Match the outermost { ... } block.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(`No JSON object in output:\n${text.slice(0, 400)}`);
  }
  return JSON.parse(text.slice(start, end + 1)) as T;
}

export async function tgSend(chatId: number | string, message: string): Promise<void> {
  await sendMessage(Number(chatId), message);
}

/**
 * Default Telegram chat for cron tasks — read from TELEGRAM_CHAT_ID in .env.
 * If TELEGRAM_CHAT_IDS (comma-separated) is set, the first id is used.
 * Throws loudly if neither is set; cron tasks should fail fast rather than
 * silently drop notifications.
 */
export function defaultChatId(): string {
  const raw = process.env.TELEGRAM_CHAT_IDS || process.env.TELEGRAM_CHAT_ID || "";
  const first = raw.split(",")[0].trim();
  if (!first) {
    throw new Error("TELEGRAM_CHAT_ID (or TELEGRAM_CHAT_IDS) not set in .env");
  }
  return first;
}

export function logToConversation(message: string): void {
  const { date, hm } = etDateAndHm();
  const path = resolve(ROOT, `data/conversations/${date}.md`);
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `\n[${hm}] bot: ${message.replace(/\n/g, " ")}\n`);
}
