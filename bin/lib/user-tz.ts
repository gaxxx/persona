/**
 * user-tz.ts — resolve the user's preferred IANA timezone from USER.md, with
 * a small alias map for common descriptive forms ("US Eastern"). Falls back
 * to the system local TZ if USER.md is missing, unparseable, or unknown.
 *
 * Used by the conversation log writers (tg-daemon, cron-helpers) so that
 * `[HH:MM]` lines and `data/conversations/YYYY-MM-DD.md` filenames are stamped
 * in the user's wall-clock time rather than UTC.
 */
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

const ALIASES: Record<string, string> = {
  "us eastern": "America/New_York",
  "eastern": "America/New_York",
  "et": "America/New_York",
  "us central": "America/Chicago",
  "central": "America/Chicago",
  "ct": "America/Chicago",
  "us mountain": "America/Denver",
  "mountain": "America/Denver",
  "mt": "America/Denver",
  "us pacific": "America/Los_Angeles",
  "pacific": "America/Los_Angeles",
  "pt": "America/Los_Angeles",
  "china": "Asia/Shanghai",
  "beijing": "Asia/Shanghai",
  "japan": "Asia/Tokyo",
  "uk": "Europe/London",
  "london": "Europe/London",
};

let cached: { tz: string; loaded: number } | null = null;
const CACHE_MS = 60_000;

function tryTz(s: string): string | null {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: s }).format(new Date());
    return s;
  } catch {
    return null;
  }
}

function systemLocalTz(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function getUserTimezone(): string {
  if (cached && Date.now() - cached.loaded < CACHE_MS) return cached.tz;
  const vault = process.env.VAULT_PATH;
  if (vault) {
    const userMd = resolve(vault, "persona/USER.md");
    if (existsSync(userMd)) {
      const text = readFileSync(userMd, "utf8");
      const m = text.match(/\*\*Timezone:\*\*\s*([^\n]+)/i);
      if (m) {
        const raw = m[1].trim();
        // Strip parenthetical hints like "US Eastern (Virginia)" before lookup.
        const bare = raw.replace(/\([^)]*\)/g, "").trim();
        // Try bare value as IANA first (e.g. "America/New_York").
        const iana = tryTz(bare);
        if (iana) return cache(iana);
        const aliased = ALIASES[bare.toLowerCase()];
        if (aliased && tryTz(aliased)) return cache(aliased);
      }
    }
  }
  return cache(systemLocalTz());
}

function cache(tz: string): string {
  cached = { tz, loaded: Date.now() };
  return tz;
}

export function userDateAndHm(d: Date = new Date()): { date: string; hm: string } {
  const tz = getUserTimezone();
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  let hour = get("hour");
  // en-CA returns "24" for midnight in some node versions; normalize.
  if (hour === "24") hour = "00";
  return { date, hm: `${hour}:${get("minute")}` };
}

// CLI: `bun run bin/lib/user-tz.ts` prints "YYYY-MM-DD HH:MM <tz>" — useful
// for the inner claude / shell scripts that need a user-local timestamp.
if (import.meta.main) {
  const { date, hm } = userDateAndHm();
  console.log(`${date} ${hm} ${getUserTimezone()}`);
}
