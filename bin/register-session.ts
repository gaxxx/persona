#!/usr/bin/env bun
/**
 * register-session.ts <role> — register the CURRENT Claude Code session into
 * data/sessions.jsonl with the given role (tg | loop | cron).
 *
 * "Current" = the most recently modified .jsonl in PROJECTS_DIR. Inside an
 * active session this is reliable: the running session writes on every
 * assistant event, so its mtime is always freshest. Idempotent — duplicate
 * registrations are no-ops.
 *
 * Used by the assistant-loop skill on each tick (cheap when already
 * registered). tg-daemon registers itself directly via the stream-json
 * system/init event and does not invoke this helper.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { resolve } from "path";
import { registerSession, type SessionRole } from "./lib/session-registry";

const HOME = process.env.HOME ?? "";
const REPO_ROOT = resolve(import.meta.dir, "..");
const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR ?? resolve(HOME, ".claude");
const PROJECTS_DIR = resolve(CONFIG_DIR, "projects", REPO_ROOT.replaceAll("/", "-"));

function findCurrentSessionId(): string | null {
  if (!existsSync(PROJECTS_DIR)) return null;
  let best: { path: string; mtime: number } | null = null;
  for (const name of readdirSync(PROJECTS_DIR)) {
    if (!name.endsWith(".jsonl")) continue;
    const p = resolve(PROJECTS_DIR, name);
    try {
      const st = statSync(p);
      if (!best || st.mtimeMs > best.mtime) best = { path: p, mtime: st.mtimeMs };
    } catch {
      // skip
    }
  }
  if (!best) return null;
  // Filename is the session_id; verify by sampling first line.
  const fname = best.path.split("/").pop()!.replace(".jsonl", "");
  try {
    const first = readFileSync(best.path, "utf8").split("\n", 2)[0];
    const obj = JSON.parse(first) as { sessionId?: string };
    return obj.sessionId ?? fname;
  } catch {
    return fname;
  }
}

const role = (process.argv[2] ?? "") as SessionRole;
if (role !== "tg" && role !== "loop" && role !== "cron") {
  console.error("usage: register-session.ts <tg|loop|cron>");
  process.exit(2);
}

const sid = findCurrentSessionId();
if (!sid) {
  // Best-effort: registration is a stats optimization, not a hard requirement.
  // Don't exit non-zero — callers (e.g. /assistant-loop) shouldn't abort.
  console.error("no session jsonl found in", PROJECTS_DIR, "— skipping registration");
  process.exit(0);
}

const wrote = registerSession(sid, role);
console.log(wrote ? `registered ${sid} as ${role}` : `${sid} already registered`);
