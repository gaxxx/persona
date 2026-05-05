/**
 * Session role registry. Maps Claude Code session_id -> role (tg / loop / cron).
 * Used by daemon-stats to bucket billing accurately instead of guessing from
 * the first user message.
 *
 * Format: data/sessions.jsonl, one line per registered session:
 *   {"session_id":"<uuid>","role":"tg|loop|cron","started_at":"<ISO>"}
 *
 * Append-only and idempotent: registerSession() no-ops if the session_id is
 * already present (loop runs the same session many times; tg-daemon may emit
 * system/init multiple times per spawn).
 */
import { existsSync, readFileSync, appendFileSync, mkdirSync } from "fs";
import { dirname, resolve } from "path";

export type SessionRole = "tg" | "loop" | "cron";

export interface RegistryEntry {
  session_id: string;
  role: SessionRole;
  started_at: string;
}

const REGISTRY_FILE = resolve(import.meta.dir, "../../data/sessions.jsonl");

let cache: Map<string, RegistryEntry> | null = null;

export function loadRegistry(): Map<string, RegistryEntry> {
  if (cache) return cache;
  const map = new Map<string, RegistryEntry>();
  if (!existsSync(REGISTRY_FILE)) {
    cache = map;
    return map;
  }
  for (const line of readFileSync(REGISTRY_FILE, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as RegistryEntry;
      if (e.session_id && e.role) map.set(e.session_id, e);
    } catch {
      // skip malformed
    }
  }
  cache = map;
  return map;
}

export function registerSession(sessionId: string, role: SessionRole): boolean {
  const map = loadRegistry();
  if (map.has(sessionId)) return false;
  const entry: RegistryEntry = {
    session_id: sessionId,
    role,
    started_at: new Date().toISOString(),
  };
  mkdirSync(dirname(REGISTRY_FILE), { recursive: true });
  appendFileSync(REGISTRY_FILE, JSON.stringify(entry) + "\n");
  map.set(sessionId, entry);
  return true;
}
