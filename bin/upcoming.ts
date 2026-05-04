#!/usr/bin/env bun
/**
 * upcoming.ts — deterministic wrapper for the upcoming-1h-preview cron.
 *
 * Replaces the inline LLM-everything prompt. The wrapper owns dedup, quiet
 * hours, sending, and persisting; the LLM is only invoked to fetch calendar
 * events as JSON. Skips the claude spawn entirely during deep quiet (01-07 ET)
 * to cut overnight token waste.
 *
 * Final stdout line is the 1-line summary cron-daemon stamps into CRON.md
 * "Last run".
 *
 * TODO: when ~/.gmail-mcp/credentials.json is re-granted with
 * calendar.readonly scope, replace fetchCalendarViaClaude() with a direct
 * Google Calendar API call. That eliminates the ~700K cache_creation per
 * fire entirely.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { createHash } from "crypto";
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

const DEDUP_PATH = resolve(ROOT, "data/upcoming-notified.json");
const TASKS_PATH = resolve(VAULT, "persona/tasks.md");
const CHAT_ID = defaultChatId();
const WINDOW_MIN = 30;
const PRUNE_HOURS = 24;

// Deep quiet — fully skip the claude spawn during these hours.
// Default user quiet is 23:30-08:00 ET; we use 01-07 as the "definitely asleep"
// core to avoid even fetching calendar. Edge hours (23, 00, 07) still fire so
// late-night arrivals / early flights get a heads-up if they wake.
const DEEP_QUIET_START_HOUR = 1;
const DEEP_QUIET_END_HOUR = 7; // exclusive

// User quiet hours for the send/no-send decision (matches CLAUDE.md default).
const QUIET_START_HOUR = 23;
const QUIET_START_MIN = 30;
const QUIET_END_HOUR = 8;

type Dedup = Record<string, string>;

function loadDedup(): Dedup {
  if (!existsSync(DEDUP_PATH)) return {};
  try {
    return JSON.parse(readFileSync(DEDUP_PATH, "utf8")) as Dedup;
  } catch {
    return {};
  }
}

function pruneDedup(d: Dedup): Dedup {
  const cutoff = Date.now() - PRUNE_HOURS * 3600 * 1000;
  const out: Dedup = {};
  for (const [k, v] of Object.entries(d)) {
    const t = new Date(v).getTime();
    if (Number.isFinite(t) && t > cutoff) out[k] = v;
  }
  return out;
}

function saveDedup(d: Dedup): void {
  if (!existsSync(dirname(DEDUP_PATH)))
    mkdirSync(dirname(DEDUP_PATH), { recursive: true });
  writeFileSync(DEDUP_PATH, JSON.stringify(d, null, 2));
}

function isDeepQuiet(d: Date): boolean {
  const h = d.getHours();
  return h >= DEEP_QUIET_START_HOUR && h < DEEP_QUIET_END_HOUR;
}

function isQuiet(d: Date): boolean {
  const h = d.getHours();
  const m = d.getMinutes();
  if (h < QUIET_END_HOUR) return true;
  if (h > QUIET_START_HOUR) return true;
  if (h === QUIET_START_HOUR && m >= QUIET_START_MIN) return true;
  return false;
}

interface CalEvent {
  id: string;
  summary: string;
  startIso: string;
  location?: string;
}

async function fetchCalendarViaClaude(now: Date): Promise<CalEvent[]> {
  const tMin = now.toISOString();
  const tMax = new Date(now.getTime() + WINDOW_MIN * 60 * 1000).toISOString();
  const prompt = `Non-interactive task. Call mcp__claude_ai_Google_Calendar__list_events with timeMin="${tMin}", timeMax="${tMax}", singleEvents=true, orderBy="startTime", maxResults=20.
Output ONLY this JSON, no prose, no markdown fences:
{"events":[{"id":"<event.id>","summary":"<event.summary>","startIso":"<event.start.dateTime or .date>","location":"<event.location or empty>"}]}
If the call returns no items, output {"events":[]}.`;
  const out = await runClaude(prompt, 90 * 1000);
  return extractJson<{ events: CalEvent[] }>(out).events ?? [];
}

interface TaskCand {
  key: string;
  title: string;
  startMs: number;
}

function parseTimeFromLine(line: string, now: Date): number | null {
  // Supports HH:MM (24h), 3pm/3PM, 下午3点, 上午8点半.
  const m24 = line.match(/\b(\d{1,2}):(\d{2})\b/);
  if (m24) {
    const h = Number(m24[1]);
    const mm = Number(m24[2]);
    if (h >= 0 && h < 24 && mm >= 0 && mm < 60) {
      const d = new Date(now);
      d.setHours(h, mm, 0, 0);
      return d.getTime();
    }
  }
  const m12 = line.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|AM|PM)\b/);
  if (m12) {
    let h = Number(m12[1]);
    const mm = Number(m12[2] ?? "0");
    const isPm = m12[3].toLowerCase() === "pm";
    if (isPm && h < 12) h += 12;
    if (!isPm && h === 12) h = 0;
    const d = new Date(now);
    d.setHours(h, mm, 0, 0);
    return d.getTime();
  }
  const mCn = line.match(/(上午|下午)?\s*(\d{1,2})\s*点(半)?/);
  if (mCn) {
    let h = Number(mCn[2]);
    if (mCn[1] === "下午" && h < 12) h += 12;
    if (mCn[1] === "上午" && h === 12) h = 0;
    const mm = mCn[3] ? 30 : 0;
    const d = new Date(now);
    d.setHours(h, mm, 0, 0);
    return d.getTime();
  }
  return null;
}

function scanTasks(now: Date): TaskCand[] {
  if (!existsSync(TASKS_PATH)) return [];
  const today = new Date(now).toISOString().slice(0, 10);
  const lines = readFileSync(TASKS_PATH, "utf8").split("\n");
  const cands: TaskCand[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith("- [ ]")) continue;
    if (!line.includes(`📅 ${today}`)) continue;
    const startMs = parseTimeFromLine(line, now);
    if (startMs === null) continue;
    const key = `task:${createHash("sha1").update(line).digest("hex").slice(0, 12)}`;
    cands.push({ key, title: line.replace(/^- \[ \]\s*/, "").replace(/📅\s*\d{4}-\d{2}-\d{2}/, "").trim(), startMs });
  }
  return cands;
}

interface FormattedCand {
  key: string;
  line: string;
  startMs: number;
}

async function main(): Promise<void> {
  const now = new Date();

  if (isDeepQuiet(now)) {
    console.log("silent (deep quiet)");
    return;
  }

  let dedup = pruneDedup(loadDedup());
  saveDedup(dedup);

  const winEnd = now.getTime() + WINDOW_MIN * 60 * 1000;
  const all: FormattedCand[] = [];

  for (const t of scanTasks(now)) {
    const key = t.key;
    if (key in dedup) continue;
    if (t.startMs < now.getTime() || t.startMs > winEnd) continue;
    const minsUntil = Math.max(0, Math.round((t.startMs - now.getTime()) / 60000));
    all.push({ key, line: `🔔 ~${minsUntil}min: ${t.title}`, startMs: t.startMs });
  }

  let calEvents: CalEvent[] = [];
  try {
    calEvents = await fetchCalendarViaClaude(now);
  } catch (err) {
    console.error("calendar fetch failed:", (err as Error).message);
  }

  for (const ev of calEvents) {
    const key = `gcal:${ev.id}`;
    if (key in dedup) continue;
    const startMs = new Date(ev.startIso).getTime();
    if (!Number.isFinite(startMs)) continue;
    if (startMs < now.getTime() || startMs > winEnd) continue;
    const minsUntil = Math.max(0, Math.round((startMs - now.getTime()) / 60000));
    const loc = ev.location ? ` @ ${ev.location}` : "";
    all.push({ key, line: `🔔 ~${minsUntil}min: ${ev.summary}${loc}`, startMs });
  }

  if (all.length === 0) {
    console.log("silent");
    return;
  }

  const quietNow = isQuiet(now);
  const anyEventInQuiet = all.some((c) => isQuiet(new Date(c.startMs)));
  const shouldSend = !quietNow || anyEventInQuiet;

  let sendStatus = "skipped (quiet)";
  if (shouldSend) {
    all.sort((a, b) => a.startMs - b.startMs);
    const msg = all.map((c) => c.line).join("\n");
    try {
      await tgSend(CHAT_ID, msg);
      logToConversation(msg);
      sendStatus = "sent";
    } catch (err) {
      console.error("tg-send failed:", (err as Error).message);
      process.exit(1);
    }
  }

  const ts = etIsoNow();
  for (const c of all) dedup[c.key] = ts;
  saveDedup(dedup);

  if (sendStatus === "sent") {
    console.log(`${all.length} event${all.length === 1 ? "" : "s"}`);
  } else {
    console.log(`silent (${all.length} suppressed, quiet hours)`);
  }
}

main().catch((err) => {
  console.error("upcoming error:", (err as Error).message);
  process.exit(1);
});
