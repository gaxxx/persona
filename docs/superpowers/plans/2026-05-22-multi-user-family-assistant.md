# Multi-User Family Assistant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Evolve the single-user personal assistant into a shared VEX IQ team assistant supporting 10 members with 1:1 DMs, a group channel, shared KB, per-user daily DM quotas, and admin management commands.

**Architecture:** A lazy subprocess pool in `tg-daemon.ts` replaces the single global subprocess — each active Telegram chat_id gets its own persistent `claude -p` process with a 30-min inactivity timeout. Member identity is loaded from `vault/persona/members/*.md` files (fs.watch hot-reload). Group messages inject the sender's profile into the event JSON so Claude knows who's speaking.

**Tech Stack:** Bun, TypeScript, Telegram Bot API, existing `bin/lib/telegram.ts` helpers, Bun test runner.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `bin/lib/members.ts` | **Create** | Parse member `.md` files, lookup by chat_id/user_id, fs.watch |
| `bin/lib/quota.ts` | **Create** | Per-chat daily DM quota tracking in `data/quotas/<chatId>.json` |
| `tests/members.test.ts` | **Create** | Unit tests for member registry |
| `tests/quota.test.ts` | **Create** | Unit tests for quota module |
| `bin/tg-daemon.ts` | **Modify** | Subprocess pool, member routing, quota, admin commands, per-channel logs |
| `bin/tg-set-commands.ts` | **Modify** | Add admin commands scoped to admin chat_id |
| `vault/persona/members/admin.md` | **Create** (runtime) | Admin member profile (filled by admin at setup) |

---

## Task 1: Member Registry Module

**Files:**
- Create: `bin/lib/members.ts`
- Create: `tests/members.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/members.test.ts`.

Note: `loadMembers()` reads `process.env.VAULT_PATH` at call time (not import time), so a top-level import works correctly with `beforeEach` env setup — no module cache-busting needed.

```typescript
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { loadMembers, getMemberByChatId, getMemberByUserId, getAdmin } from "../bin/lib/members";

const TEST_VAULT = "/tmp/test-vault-members";
const ORIG_VAULT = process.env.VAULT_PATH;

beforeEach(() => {
  mkdirSync(`${TEST_VAULT}/persona/members`, { recursive: true });
  process.env.VAULT_PATH = TEST_VAULT;
});

afterEach(() => {
  rmSync(TEST_VAULT, { recursive: true, force: true });
  if (ORIG_VAULT !== undefined) process.env.VAULT_PATH = ORIG_VAULT;
  else delete process.env.VAULT_PATH;
});

describe("loadMembers", () => {
  test("returns empty array when directory is missing", () => {
    rmSync(`${TEST_VAULT}/persona/members`, { recursive: true });
    expect(loadMembers()).toEqual([]);
  });

  test("returns empty array when directory is empty", () => {
    expect(loadMembers()).toEqual([]);
  });

  test("parses a full member file", () => {
    writeFileSync(
      `${TEST_VAULT}/persona/members/alex.md`,
      `---\nname: Alex\ntelegram_chat_id: 12345678\ntelegram_user_id: 87654321\nrole: driver\ndaily_dm_quota: 30\nadded_at: 2026-01-01\n---\nNotes about Alex.`,
    );
    const members = loadMembers();
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({
      name: "Alex",
      telegram_chat_id: 12345678,
      telegram_user_id: 87654321,
      role: "driver",
      daily_dm_quota: 30,
      is_admin: false,
      filename: "alex.md",
      notes: "Notes about Alex.",
    });
  });

  test("marks admin.md as is_admin=true", () => {
    writeFileSync(
      `${TEST_VAULT}/persona/members/admin.md`,
      `---\nname: Boss\ntelegram_chat_id: 99999\ntelegram_user_id: 88888\n---`,
    );
    expect(loadMembers()[0].is_admin).toBe(true);
  });

  test("non-admin.md files are is_admin=false", () => {
    writeFileSync(
      `${TEST_VAULT}/persona/members/mia.md`,
      `---\nname: Mia\ntelegram_chat_id: 111\ntelegram_user_id: 222\n---`,
    );
    expect(loadMembers()[0].is_admin).toBe(false);
  });

  test("role and daily_dm_quota are optional", () => {
    writeFileSync(
      `${TEST_VAULT}/persona/members/mia.md`,
      `---\nname: Mia\ntelegram_chat_id: 111\ntelegram_user_id: 222\n---`,
    );
    const [m] = loadMembers();
    expect(m.role).toBeUndefined();
    expect(m.daily_dm_quota).toBeUndefined();
  });

  test("skips files missing required fields", () => {
    writeFileSync(
      `${TEST_VAULT}/persona/members/bad.md`,
      `---\nname: NoIds\n---`,
    );
    expect(loadMembers()).toHaveLength(0);
  });

  test("skips non-.md files", () => {
    writeFileSync(`${TEST_VAULT}/persona/members/readme.txt`, "ignore me");
    expect(loadMembers()).toHaveLength(0);
  });
});

describe("getMemberByChatId", () => {
  test("returns matching member", () => {
    writeFileSync(
      `${TEST_VAULT}/persona/members/alex.md`,
      `---\nname: Alex\ntelegram_chat_id: 12345678\ntelegram_user_id: 87654321\n---`,
    );
    const members = loadMembers();
    expect(getMemberByChatId(members, 12345678)?.name).toBe("Alex");
  });

  test("returns undefined for unknown chat_id", () => {
    expect(getMemberByChatId([], 999)).toBeUndefined();
  });
});

describe("getMemberByUserId", () => {
  test("returns matching member", () => {
    writeFileSync(
      `${TEST_VAULT}/persona/members/alex.md`,
      `---\nname: Alex\ntelegram_chat_id: 12345678\ntelegram_user_id: 87654321\n---`,
    );
    const members = loadMembers();
    expect(getMemberByUserId(members, 87654321)?.name).toBe("Alex");
  });
});

describe("getAdmin", () => {
  test("returns the admin member", () => {
    writeFileSync(
      `${TEST_VAULT}/persona/members/admin.md`,
      `---\nname: Boss\ntelegram_chat_id: 99999\ntelegram_user_id: 88888\n---`,
    );
    writeFileSync(
      `${TEST_VAULT}/persona/members/alex.md`,
      `---\nname: Alex\ntelegram_chat_id: 111\ntelegram_user_id: 222\n---`,
    );
    const members = loadMembers();
    expect(getAdmin(members)?.is_admin).toBe(true);
    expect(getAdmin(members)?.name).toBe("Boss");
  });

  test("returns undefined when no admin.md exists", () => {
    writeFileSync(
      `${TEST_VAULT}/persona/members/alex.md`,
      `---\nname: Alex\ntelegram_chat_id: 111\ntelegram_user_id: 222\n---`,
    );
    expect(getAdmin(loadMembers())).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun test tests/members.test.ts 2>&1 | head -20
```

Expected: error about `../bin/lib/members.ts` not found.

- [ ] **Step 3: Create `bin/lib/members.ts`**

```typescript
import { readdirSync, readFileSync } from "fs";
import { watch } from "fs";
import { join } from "path";

export interface Member {
  name: string;
  telegram_chat_id: number;
  telegram_user_id: number;
  role?: string;
  daily_dm_quota?: number;
  is_admin: boolean;
  notes: string;
  filename: string;
}

function membersDir(): string {
  const vault = process.env.VAULT_PATH ?? "/vault";
  return join(vault, "persona", "members");
}

function parseFrontmatter(content: string): { meta: Record<string, unknown>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: content.trim() };
  const [, fmRaw, body] = match;
  const meta: Record<string, unknown> = {};
  for (const line of fmRaw.split("\n")) {
    const m = line.match(/^([\w]+):\s*(.+)$/);
    if (m) {
      const val = m[2].trim();
      meta[m[1]] = isNaN(Number(val)) ? val : Number(val);
    }
  }
  return { meta, body: body.trim() };
}

export function loadMembers(): Member[] {
  const dir = membersDir();
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  const members: Member[] = [];
  for (const file of files) {
    try {
      const content = readFileSync(join(dir, file), "utf-8");
      const { meta, body } = parseFrontmatter(content);
      if (!meta.name || !meta.telegram_chat_id || !meta.telegram_user_id) continue;
      members.push({
        name: String(meta.name),
        telegram_chat_id: Number(meta.telegram_chat_id),
        telegram_user_id: Number(meta.telegram_user_id),
        role: meta.role !== undefined ? String(meta.role) : undefined,
        daily_dm_quota: meta.daily_dm_quota !== undefined ? Number(meta.daily_dm_quota) : undefined,
        is_admin: file === "admin.md",
        notes: body,
        filename: file,
      });
    } catch {
      continue;
    }
  }
  return members;
}

export function getMemberByChatId(members: Member[], chatId: number): Member | undefined {
  return members.find((m) => m.telegram_chat_id === chatId);
}

export function getMemberByUserId(members: Member[], userId: number): Member | undefined {
  return members.find((m) => m.telegram_user_id === userId);
}

export function getAdmin(members: Member[]): Member | undefined {
  return members.find((m) => m.is_admin);
}

export function watchMembers(callback: () => void): void {
  try {
    let debounce: ReturnType<typeof setTimeout> | undefined;
    watch(membersDir(), { persistent: false }, () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(callback, 500);
    });
  } catch {
    // directory may not exist yet — watch will be set up on first reload
  }
}
```

- [ ] **Step 4: Run tests and confirm they pass**

```bash
bun test tests/members.test.ts
```

Expected output:
```
✓ loadMembers > returns empty array when directory is missing
✓ loadMembers > returns empty array when directory is empty
✓ loadMembers > parses a full member file
✓ loadMembers > marks admin.md as is_admin=true
...
Tests: 10 passed
```

- [ ] **Step 5: Commit**

```bash
git add bin/lib/members.ts tests/members.test.ts
git commit -m "feat: add member registry module with unit tests"
```

---

## Task 2: Quota Module

**Files:**
- Create: `bin/lib/quota.ts`
- Create: `tests/quota.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/quota.test.ts`.

Note: `quotaDir()` reads `process.env.DATA_DIR` at call time, so top-level imports work with `beforeEach` env setup.

```typescript
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { checkAndIncrementQuota, resetQuota, getQuotaStatus } from "../bin/lib/quota";
import type { Member } from "../bin/lib/members";

const TEST_DATA = "/tmp/test-quota-data";
const ORIG_DATA_DIR = process.env.DATA_DIR;

beforeEach(() => {
  mkdirSync(TEST_DATA, { recursive: true });
  process.env.DATA_DIR = TEST_DATA;
});

afterEach(() => {
  rmSync(TEST_DATA, { recursive: true, force: true });
  if (ORIG_DATA_DIR !== undefined) process.env.DATA_DIR = ORIG_DATA_DIR;
  else delete process.env.DATA_DIR;
});

function makeMember(overrides: {
  is_admin?: boolean;
  daily_dm_quota?: number;
} = {}): Member {
  return {
    name: "Alex",
    telegram_chat_id: 12345,
    telegram_user_id: 67890,
    daily_dm_quota: overrides.daily_dm_quota,
    is_admin: overrides.is_admin ?? false,
    notes: "",
    filename: "alex.md",
  };
}

describe("checkAndIncrementQuota", () => {
  test("allows first message", () => {
    const member = makeMember({ daily_dm_quota: 3 });
    expect(checkAndIncrementQuota(12345, member).allowed).toBe(true);
  });

  test("increments count on each allowed message", () => {
    const member = makeMember({ daily_dm_quota: 3 });
    checkAndIncrementQuota(12345, member);
    checkAndIncrementQuota(12345, member);
    expect(getQuotaStatus(12345, member).count).toBe(2);
  });

  test("blocks when count reaches quota", () => {
    const member = makeMember({ daily_dm_quota: 2 });
    checkAndIncrementQuota(12345, member);
    checkAndIncrementQuota(12345, member);
    expect(checkAndIncrementQuota(12345, member).allowed).toBe(false);
  });

  test("uses DEFAULT_DM_QUOTA (50) when daily_dm_quota is undefined", () => {
    const member = makeMember(); // no daily_dm_quota
    for (let i = 0; i < 50; i++) {
      expect(checkAndIncrementQuota(12345, member).allowed).toBe(true);
    }
    expect(checkAndIncrementQuota(12345, member).allowed).toBe(false);
  });

  test("always allows admin regardless of count", () => {
    const admin = makeMember({ is_admin: true, daily_dm_quota: 1 });
    checkAndIncrementQuota(12345, admin);
    checkAndIncrementQuota(12345, admin);
    expect(checkAndIncrementQuota(12345, admin).allowed).toBe(true);
  });

  test("resets count when date changes", () => {
    const member = makeMember({ daily_dm_quota: 2 });
    // Exhaust quota
    checkAndIncrementQuota(12345, member);
    checkAndIncrementQuota(12345, member);
    // Simulate yesterday by writing stale file directly
    mkdirSync(`${TEST_DATA}/quotas`, { recursive: true });
    writeFileSync(`${TEST_DATA}/quotas/12345.json`, JSON.stringify({ date: "2020-01-01", count: 2 }));
    // Should reset and allow
    expect(checkAndIncrementQuota(12345, member).allowed).toBe(true);
    expect(getQuotaStatus(12345, member).count).toBe(1);
  });
});

describe("resetQuota", () => {
  test("resets count to 0", () => {
    const member = makeMember({ daily_dm_quota: 5 });
    checkAndIncrementQuota(12345, member);
    checkAndIncrementQuota(12345, member);
    resetQuota(12345);
    expect(getQuotaStatus(12345, member).count).toBe(0);
  });
});

describe("getQuotaStatus", () => {
  test("returns null limit for admin", () => {
    const admin = makeMember({ is_admin: true });
    expect(getQuotaStatus(12345, admin).limit).toBeNull();
  });

  test("returns correct limit for member with quota", () => {
    const member = makeMember({ daily_dm_quota: 30 });
    expect(getQuotaStatus(12345, member).limit).toBe(30);
  });

  test("returns 0 count for fresh member", () => {
    const member = makeMember({ daily_dm_quota: 50 });
    expect(getQuotaStatus(12345, member).count).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun test tests/quota.test.ts 2>&1 | head -5
```

Expected: error about `../bin/lib/quota.ts` not found.

- [ ] **Step 3: Create `bin/lib/quota.ts`**

```typescript
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import type { Member } from "./members";

const DEFAULT_DM_QUOTA = 50;

function quotaDir(): string {
  return join(process.env.DATA_DIR ?? "data", "quotas");
}

function quotaPath(chatId: number): string {
  return join(quotaDir(), `${chatId}.json`);
}

interface QuotaRecord {
  date: string;
  count: number;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function loadRecord(chatId: number): QuotaRecord {
  try {
    return JSON.parse(readFileSync(quotaPath(chatId), "utf-8")) as QuotaRecord;
  } catch {
    return { date: todayIso(), count: 0 };
  }
}

function saveRecord(chatId: number, record: QuotaRecord): void {
  const dir = quotaDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(quotaPath(chatId), JSON.stringify(record));
}

export function checkAndIncrementQuota(chatId: number, member: Member): { allowed: boolean } {
  if (member.is_admin) return { allowed: true };
  const quota = member.daily_dm_quota ?? DEFAULT_DM_QUOTA;
  const record = loadRecord(chatId);
  const today = todayIso();
  if (record.date !== today) {
    record.date = today;
    record.count = 0;
  }
  if (record.count >= quota) return { allowed: false };
  record.count++;
  saveRecord(chatId, record);
  return { allowed: true };
}

export function resetQuota(chatId: number): void {
  saveRecord(chatId, { date: todayIso(), count: 0 });
}

export function getQuotaStatus(
  chatId: number,
  member: Member,
): { count: number; limit: number | null; date: string } {
  if (member.is_admin) return { count: 0, limit: null, date: todayIso() };
  const record = loadRecord(chatId);
  const today = todayIso();
  const count = record.date === today ? record.count : 0;
  return { count, limit: member.daily_dm_quota ?? DEFAULT_DM_QUOTA, date: today };
}
```

- [ ] **Step 4: Run tests and confirm they pass**

```bash
bun test tests/quota.test.ts
```

Expected:
```
✓ checkAndIncrementQuota > allows first message
✓ checkAndIncrementQuota > increments count on each allowed message
...
Tests: 9 passed
```

- [ ] **Step 5: Commit**

```bash
git add bin/lib/quota.ts tests/quota.test.ts
git commit -m "feat: add per-user DM quota module with unit tests"
```

---

## Task 3: Daemon — Member Registry Integration

**Files:**
- Modify: `bin/tg-daemon.ts`

Replace the env-var allowlist (`ALLOWED_CHAT_IDS`) with the member registry. Add channel-type detection. This task does NOT change the subprocess model — the single `claude` subprocess is kept intact here and replaced in Task 4.

- [ ] **Step 1: Add imports at the top of `bin/tg-daemon.ts`**

After the existing imports (line 21), add:

```typescript
import { loadMembers, getMemberByChatId, getMemberByUserId, getAdmin, watchMembers, type Member } from "./lib/members";
import { checkAndIncrementQuota, resetQuota, getQuotaStatus } from "./lib/quota";
```

- [ ] **Step 2: Replace `ALLOWED_CHAT_IDS` block with member registry**

Remove lines 42–56 (the `ALLOWED_CHAT_IDS` block and its fatal check). Replace with:

```typescript
// Member registry — loaded from vault/persona/members/*.md. Hot-reloads on change.
let members: Member[] = loadMembers();
watchMembers(() => {
  members = loadMembers();
  log(`members reloaded: ${members.map((m) => m.name).join(", ") || "(none)"}`);
});

// The admin member (admin.md). Used for rate-limit notifications and admin commands.
// Falls back to first member if no admin.md exists.
function adminMember(): Member | undefined {
  return getAdmin(members) ?? members[0];
}

// Track the group chat_id once we see the first group message. Used to inject
// group log path into DM subprocess PRIMINGs so they can load shared context.
let groupChatId: number | null = null;
```

- [ ] **Step 3: Replace `PRIMARY_CHAT_ID` with a dynamic lookup**

Remove line 269 (`const PRIMARY_CHAT_ID = [...ALLOWED_CHAT_IDS][0];`). References to `PRIMARY_CHAT_ID` in `notifyRateLimitWarning` and `notifyRateLimitRejected` become `adminMember()?.telegram_chat_id ?? 0`. Apply both replacements:

```typescript
// In notifyRateLimitWarning, replace:
//   await sendMessage(PRIMARY_CHAT_ID, ...)
// with:
    const adminId = adminMember()?.telegram_chat_id;
    if (!adminId) return;
    await sendMessage(adminId, `🐉 ...`);

// In notifyRateLimitRejected, same pattern:
    const adminId = adminMember()?.telegram_chat_id;
    if (!adminId) return;
    await sendMessage(adminId, `⏸ ...`);
```

- [ ] **Step 4: Update the main poll loop's message filter**

In the `while (!stopping)` loop, replace the `ALLOWED_CHAT_IDS.has(m.chat.id)` check (around line 950) with a member-registry check:

```typescript
    // Reject messages from unknown chats.
    // DMs: sender must be in registry by chat_id.
    // Groups: at least one member must be in this group (accept the group chat_id itself).
    const channelType = m.chat.type === "private" ? "dm" : "group";
    if (channelType === "dm") {
      if (!getMemberByChatId(members, m.chat.id)) {
        log("rejected: unknown DM chat_id", m.chat.id);
        offset = u.update_id + 1; await saveOffset(); continue;
      }
    } else {
      // For group messages, track the group chat_id and check the sender.
      groupChatId = m.chat.id;
      if (m.from?.id && !getMemberByUserId(members, m.from.id)) {
        log("rejected: unknown user_id in group", m.from?.id);
        offset = u.update_id + 1; await saveOffset(); continue;
      }
    }
```

Place this block immediately after the existing `if (!m)` check, replacing the old `if (!ALLOWED_CHAT_IDS.has(...))` block.

- [ ] **Step 5: Type-check**

```bash
bunx tsc --noEmit
```

Expected: 0 errors. Fix any type errors before proceeding.

- [ ] **Step 6: Smoke test startup**

```bash
TELEGRAM_BOT_TOKEN=test TELEGRAM_CHAT_ID=123 VAULT_PATH=/vault timeout 3 bun run bin/tg-daemon.ts 2>&1 | head -10
```

Expected: daemon starts, logs `"members reloaded: ..."` or `"(none)"`, then hits PRIMING. No crash from missing `ALLOWED_CHAT_IDS`.

- [ ] **Step 7: Commit**

```bash
git add bin/tg-daemon.ts
git commit -m "feat(daemon): replace ALLOWED_CHAT_IDS with member registry"
```

---

## Task 4: Daemon — Subprocess Pool and Per-Channel PRIMINGs

**Files:**
- Modify: `bin/tg-daemon.ts`

Replace the single `claude: ClaudeProc` global with a per-chat subprocess pool. Add per-channel PRIMING builders and per-channel conversation log paths.

- [ ] **Step 1: Add the pool type and inactivity constants after existing `ClaudeProc` interface (around line 254)**

```typescript
const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000; // 30 min

interface PoolEntry {
  proc: ClaudeProc;
  priming: string;   // stored so exit handler can re-send on respawn
  inactivityTimer: ReturnType<typeof setTimeout>;
}

const subprocessPool = new Map<number, PoolEntry>();
```

- [ ] **Step 2: Add per-channel log path helpers**

Replace the existing `todayLogPath()` function (around line 657) and update `readExternalWritesSinceLastTurn` and `noteLogConsumed` to be per-channel:

```typescript
function todayChannelLog(
  chatId: number,
  channelType: "dm" | "group",
): { date: string; path: string } {
  const { date } = userDateAndHm();
  const dir = `data/conversations/${channelType}-${chatId}`;
  return { date, path: `${dir}/${date}.md` };
}

function readExternalWritesSinceLastTurn(
  chatId: number,
  channelType: "dm" | "group",
): string | null {
  const { path } = todayChannelLog(chatId, channelType);
  const size = currentLogSize(path);
  const last = lastSeenLogSizes[path];
  if (last === undefined) {
    lastSeenLogSizes[path] = size;
    return null;
  }
  if (size <= last) return null;
  let chunk: string;
  try {
    const buf = readFileSync(path);
    chunk = buf.subarray(last).toString("utf-8");
  } catch {
    lastSeenLogSizes[path] = size;
    return null;
  }
  lastSeenLogSizes[path] = size;
  if (chunk.length > MAX_EXTERNAL_WRITES_BYTES) {
    return chunk.slice(0, MAX_EXTERNAL_WRITES_BYTES) +
      `\n…[TRUNCATED ${chunk.length - MAX_EXTERNAL_WRITES_BYTES} bytes — Read the file for the rest]`;
  }
  return chunk || null;
}

function noteLogConsumed(chatId: number, channelType: "dm" | "group"): void {
  const { path } = todayChannelLog(chatId, channelType);
  lastSeenLogSizes[path] = currentLogSize(path);
}
```

Remove the old `todayLogPath()`, `readExternalWritesSinceLastTurn()` (no params), and `noteLogConsumed()` (no params) definitions.

- [ ] **Step 3: Add PRIMING builder functions**

Add these two functions after the `PRIMING` constant (keep the original `PRIMING` const — the builders derive from it). Insert after line 238 (the `Acknowledge with the single word READY.\`;` line):

```typescript
// Build a DM-channel PRIMING for a specific member.
// Substitutes the member's profile path and per-channel log dir into the base PRIMING.
function buildDmPriming(member: Member, knownGroupChatId: number | null): string {
  const dmLogDir = `data/conversations/dm-${member.telegram_chat_id}`;
  const profileLine = member.is_admin
    ? `Read CLAUDE.md and <vault>/persona/USER.md to learn who your human is.`
    : `Read CLAUDE.md and <vault>/persona/members/${member.filename} to learn about ${member.name}${member.role ? ` (${member.role})` : ""}.`;
  const groupNote = knownGroupChatId !== null
    ? `\nAlso read data/conversations/group-${knownGroupChatId}/<date>.md on the first turn to share context with the group channel (all context is public).`
    : "";
  return PRIMING
    .replace(
      `Read CLAUDE.md and <vault>/persona/USER.md to learn who your human is.`,
      profileLine + groupNote,
    )
    .replace(/data\/conversations\/YYYY-MM-DD\.md/g, `${dmLogDir}/YYYY-MM-DD.md`);
}

// Build a group-channel PRIMING. All member identities are in context;
// each turn's event JSON includes from_name + member_role for the speaker.
function buildGroupPriming(allMembers: Member[], chatId: number): string {
  const groupLogDir = `data/conversations/group-${chatId}`;
  const memberList = allMembers.length > 0
    ? allMembers.map((m) => `- ${m.name}${m.role ? ` (${m.role})` : ""}`).join("\n")
    : "(no members registered yet)";
  const groupHeader =
    `You are a team assistant for a VEX IQ competition group (2026 season). Read CLAUDE.md for behavior.\n` +
    `Team members:\n${memberList}\n` +
    `Each turn's event JSON includes \`from_name\` (the speaker's name) and optionally \`member_role\`. ` +
    `Use these to address them by name and tailor your response.`;
  return PRIMING
    .replace(
      `You are a personal assistant running inside a long-lived daemon process. Read CLAUDE.md and <vault>/persona/USER.md to learn who your human is.`,
      `You are a personal assistant running inside a long-lived daemon process. ${groupHeader}`,
    )
    .replace(/data\/conversations\/YYYY-MM-DD\.md/g, `${groupLogDir}/YYYY-MM-DD.md`);
}
```

- [ ] **Step 4: Add pool management helpers**

Add these functions after the `rotateIfNeeded` function (around line 648). They replace the single-subprocess management:

```typescript
// ---- Subprocess pool management -------------------------------------------

function startInactivityTimer(chatId: number): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    const entry = subprocessPool.get(chatId);
    if (!entry) return;
    log(`chat ${chatId}: inactivity timeout, shutting down subprocess`);
    subprocessPool.delete(chatId);
    entry.proc.shutdown().catch((e) => log("inactivity shutdown error:", (e as Error).message));
  }, INACTIVITY_TIMEOUT_MS);
}

function resetInactivityTimer(chatId: number): void {
  const entry = subprocessPool.get(chatId);
  if (!entry) return;
  clearTimeout(entry.inactivityTimer);
  entry.inactivityTimer = startInactivityTimer(chatId);
}

function attachPoolExitHandler(chatId: number, proc: ClaudeProc, priming: string): void {
  proc.proc.exited.then(async () => {
    const entry = subprocessPool.get(chatId);
    if (!entry || entry.proc !== proc) return; // stale handler, a rotation already replaced this proc
    log(`chat ${chatId}: proc exited, auto-respawning`);
    const newProc = spawnClaude();
    const newTimer = startInactivityTimer(chatId);
    subprocessPool.set(chatId, { proc: newProc, priming, inactivityTimer: newTimer });
    attachPoolExitHandler(chatId, newProc, priming);
    try {
      await newProc.enqueue(priming);
    } catch (e) {
      log(`chat ${chatId}: auto-respawn priming failed:`, (e as Error).message);
    }
  });
}

// Get or spawn the subprocess for a chat_id. Rotates if the proc has exceeded
// turn/age/cache limits. Resets the inactivity timer on each call.
async function ensureProc(chatId: number, priming: string): Promise<ClaudeProc> {
  const entry = subprocessPool.get(chatId);

  // Dead or missing — spawn fresh.
  if (!entry || entry.proc.isDead()) {
    if (entry) clearTimeout(entry.inactivityTimer);
    const proc = spawnClaude();
    const timer = startInactivityTimer(chatId);
    subprocessPool.set(chatId, { proc, priming, inactivityTimer: timer });
    attachPoolExitHandler(chatId, proc, priming);
    await proc.enqueue(priming);
    return proc;
  }

  const { proc } = entry;
  const tooOld = Date.now() - proc.spawnedAt > MAX_AGE_MS;
  const tooMany = proc.getTurns() >= MAX_TURNS;
  const tooBig =
    proc.getTurns() >= MIN_TURNS_FOR_CACHE_ROTATION &&
    proc.getLastCacheRead() > MAX_CACHE_READ;

  if (tooOld || tooMany || tooBig) {
    log(`chat ${chatId}: rotating proc (turns=${proc.getTurns()} age=${Date.now() - proc.spawnedAt}ms cache=${proc.getLastCacheRead()})`);
    try {
      await Promise.race([
        proc.enqueue("Pre-rotation flush: persist any in-flight working state to disk now (data/scratchpad.md updates, pending notes). Reply 'flushed' when done. No tg-send for this turn."),
        new Promise<never>((_, rj) => setTimeout(() => rj(new Error("flush timeout")), 30_000)),
      ]);
    } catch (e) {
      log(`chat ${chatId}: pre-rotation flush failed (proceeding):`, (e as Error).message);
    }
    const oldProc = proc;
    const newProc = spawnClaude();
    const newTimer = startInactivityTimer(chatId);
    subprocessPool.set(chatId, { proc: newProc, priming, inactivityTimer: newTimer });
    attachPoolExitHandler(chatId, newProc, priming);
    await newProc.enqueue(priming);
    oldProc.shutdown().catch((e) => log(`chat ${chatId}: old proc shutdown error:`, (e as Error).message));
    return newProc;
  }

  resetInactivityTimer(chatId);
  return proc;
}
```

- [ ] **Step 5: Remove the single-subprocess initialization and update `stop` handler**

Find and remove the following block (search for `let claude = spawnClaude()`):
```typescript
let claude = spawnClaude();
attachExitHandler(claude);
await claude.enqueue(PRIMING);
log("priming complete, entering poll loop");
```

Find and remove the `attachExitHandler` function (search for `function attachExitHandler`).

Find and remove the `rotateIfNeeded` function (search for `async function rotateIfNeeded`). It is fully replaced by `ensureProc` inside the pool.

Update the `stop` handler to shut down all pool entries:
```typescript
const stop = async (sig: string) => {
  if (stopping) return;
  stopping = true;
  log("received", sig, "shutting down");
  // Shut down all pooled subprocesses
  const shutdowns = [...subprocessPool.values()].map((entry) => {
    clearTimeout(entry.inactivityTimer);
    return entry.proc.shutdown();
  });
  await Promise.allSettled(shutdowns);
  subprocessPool.clear();
  await saveOffset();
  process.exit(0);
};
```

Add this log line after `if (!existsSync("data")) mkdirSync("data", { recursive: true });`:
```typescript
log("priming complete, entering poll loop");
```

- [ ] **Step 6: Type-check**

```bash
bunx tsc --noEmit
```

Fix any errors before continuing.

- [ ] **Step 7: Commit**

```bash
git add bin/tg-daemon.ts
git commit -m "feat(daemon): replace single subprocess with per-channel lazy pool"
```

---

## Task 5: Daemon — Dispatch Refactor, Quota Enforcement, Admin Commands

**Files:**
- Modify: `bin/tg-daemon.ts`

Rewire `dispatch()` to use the pool, inject member identity for group messages, enforce DM quotas, and handle admin commands.

- [ ] **Step 1: Update `handleStatsCommand` to accept channel params**

Replace the existing `handleStatsCommand(chatId: number)` with:

```typescript
async function handleStatsCommand(chatId: number, channelType: "dm" | "group"): Promise<void> {
  const proc = Bun.spawn(["bun", "run", "bin/daemon-stats.ts"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  const body = out.trim() || "(no output)";
  await sendMessage(chatId, "```\n" + body + "\n```");
  const { date, hm } = userDateAndHm();
  const { path: logPath } = todayChannelLog(chatId, channelType);
  if (!existsSync(`data/conversations/${channelType}-${chatId}`))
    mkdirSync(`data/conversations/${channelType}-${chatId}`, { recursive: true });
  appendFileSync(logPath, `\n[${hm}] user: /stats\n[${hm}] bot: ${body.replace(/\n/g, " | ")}\n`);
  noteLogConsumed(chatId, channelType);
}
```

- [ ] **Step 2: Add `handleAdminCommand` function**

Add before `dispatch()`:

```typescript
async function handleAdminCommand(text: string, chatId: number): Promise<boolean> {
  const trim = text.trim();

  if (trim === "/list_members") {
    const lines = ["Members:"];
    for (const m of members) {
      const s = getQuotaStatus(m.telegram_chat_id, m);
      const limitStr = s.limit === null ? "∞" : String(s.limit);
      lines.push(`• ${m.name}${m.role ? ` [${m.role}]` : ""}${m.is_admin ? " (admin)" : ""}: ${s.count}/${limitStr} msgs today`);
    }
    await sendMessage(chatId, lines.join("\n"));
    return true;
  }

  const quotaMatch = trim.match(/^\/quota\s+(\S+)$/i);
  if (quotaMatch) {
    const query = quotaMatch[1].toLowerCase();
    const member = members.find(
      (m) => m.name.toLowerCase() === query || m.filename.replace(".md", "").toLowerCase() === query,
    );
    if (!member) {
      await sendMessage(chatId, `Member "${quotaMatch[1]}" not found.`);
    } else {
      const s = getQuotaStatus(member.telegram_chat_id, member);
      const limitStr = s.limit === null ? "unlimited" : String(s.limit);
      await sendMessage(chatId, `${member.name}: ${s.count}/${limitStr} messages today`);
    }
    return true;
  }

  const resetMatch = trim.match(/^\/reset_quota\s+(\S+)$/i);
  if (resetMatch) {
    const query = resetMatch[1].toLowerCase();
    const member = members.find(
      (m) => m.name.toLowerCase() === query || m.filename.replace(".md", "").toLowerCase() === query,
    );
    if (!member) {
      await sendMessage(chatId, `Member "${resetMatch[1]}" not found.`);
    } else {
      resetQuota(member.telegram_chat_id);
      await sendMessage(chatId, `✓ Reset ${member.name}'s daily quota`);
    }
    return true;
  }

  return false; // not an admin command
}
```

- [ ] **Step 3: Rewrite `dispatch()` to use the pool**

Replace the existing `dispatch` function entirely:

```typescript
async function dispatch(m: TelegramMessage, attachments: PendingAttachment[]): Promise<void> {
  const chatId = m.chat.id;
  const channelType: "dm" | "group" = m.chat.type === "private" ? "dm" : "group";

  // Resolve member identity
  let member: Member | undefined;
  if (channelType === "dm") {
    member = getMemberByChatId(members, chatId);
    if (!member) { log("dispatch: no member for DM chat_id", chatId); return; }
  } else {
    if (m.from?.id) member = getMemberByUserId(members, m.from.id);
    // Unknown group sender: silently ignore (already filtered in main loop, but belt+suspenders)
  }

  // Admin commands (DM from admin only, before quota check)
  if (channelType === "dm" && member?.is_admin) {
    const text = (m.text ?? "").trim();
    if (
      text.startsWith("/list_members") ||
      text.startsWith("/quota ") ||
      text.startsWith("/reset_quota ")
    ) {
      await handleAdminCommand(text, chatId);
      return;
    }
  }

  // Stats short-circuit (all users)
  if ((m.text ?? "").trim() === "/stats" && attachments.length === 0) {
    log("dispatch: /stats short-circuit");
    await handleStatsCommand(chatId, channelType);
    return;
  }

  // DM quota check
  if (channelType === "dm" && member) {
    const quota = checkAndIncrementQuota(chatId, member);
    if (!quota.allowed) {
      await sendMessage(
        chatId,
        "You've reached your daily message limit. Resets tomorrow. You can still ask me in the group channel anytime 🙏",
      );
      return;
    }
  }

  // Build priming for this channel (used on first spawn or rotation)
  const priming =
    channelType === "dm" && member
      ? buildDmPriming(member, groupChatId)
      : buildGroupPriming(members, chatId);

  // Get or spawn the subprocess for this channel
  const proc = await ensureProc(chatId, priming);

  // Build event JSON, injecting member identity for group messages
  let replyTo;
  if (m.reply_to_message) {
    const r = m.reply_to_message;
    const kind = r.photo?.length ? "photo" : r.document ? "document" : r.sticker ? "sticker" : undefined;
    replyTo = {
      message_id: r.message_id,
      from_bot: r.from?.is_bot === true,
      text: r.text || r.caption || (kind ? `[${kind}]` : ""),
      attachment_kind: kind,
      attachment_name: r.document?.file_name,
    };
  }
  const first = attachments[0];
  const placeholder = first
    ? `[${first.kind}${attachments.length > 1 ? ` x${attachments.length}` : ""}]`
    : "";
  const event: Record<string, unknown> = {
    chat_id: chatId,
    channel: channelType,
    from: m.from
      ? `${m.from.first_name}${m.from.username ? ` (@${m.from.username})` : ""}`
      : "unknown",
    text: m.text || m.caption || placeholder,
    reply_to: replyTo,
    date: new Date(m.date * 1000).toISOString(),
    message_id: m.message_id,
  };
  if (channelType === "group" && member) {
    event.from_name = member.name;
    if (member.role) event.member_role = member.role;
  }
  if (attachments.length === 1) event.attachment = attachments[0];
  else if (attachments.length > 1) event.attachments = attachments;

  const externalWrites = readExternalWritesSinceLastTurn(chatId, channelType);
  if (externalWrites) event.external_writes_since_last_turn = externalWrites;
  const activeThreads = readActiveThreadSlugs();
  if (activeThreads.length > 0) event.active_threads = activeThreads;

  log("-> telegram event", event);
  sendTyping(chatId).catch(() => {});
  const typingTimer = setInterval(() => { sendTyping(chatId).catch(() => {}); }, 4000);

  try {
    const turnResult = await proc.enqueue(`[Telegram event] ${JSON.stringify(event)}`);
    if (AUTH_ERROR_PATTERN.test(turnResult.result)) {
      log("auth failure detected, killing subprocess for chat", chatId);
      sendMessage(chatId, "🚨 Auth expired, restarting subprocess. Resend in a moment~")
        .catch((e) => log("auth-alert send failed:", (e as Error).message));
      try { proc.proc.kill(); } catch {}
      return;
    }
    if (!turnResult.sawTgSend && turnResult.result.trim()) {
      try {
        await sendMessage(chatId, turnResult.result);
        const { hm } = userDateAndHm();
        const { path: logPath } = todayChannelLog(chatId, channelType);
        const logDir = `data/conversations/${channelType}-${chatId}`;
        if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
        appendFileSync(logPath, `[${hm}] bot: ${turnResult.result.replace(/\n/g, " | ")}\n`);
      } catch (e) {
        log("auto-send failed:", (e as Error).message);
      }
    }
    noteLogConsumed(chatId, channelType);
  } catch (err) {
    const e = err as Error;
    log("enqueue failed:", e.message);
    if (e.message === TURN_TIMEOUT_ERR) {
      sendMessage(chatId, "处理这条消息卡住了 😔 重发一遍或者换个说法试试？")
        .catch((se) => log("apology send failed:", (se as Error).message));
    }
  } finally {
    clearInterval(typingTimer);
  }
}
```

- [ ] **Step 4: Update the media group `dispatch` call**

In `fireMediaGroup`, the call is already `dispatch(buf.first, buf.attachments)` — no change needed there.

In the main poll loop's call site (around line 974), update the `handleStatsCommand` call if it exists at the top level (the current inline check at dispatch entry is now inside `dispatch()` itself):

The outer loop already just calls `await dispatch(m, att ? [att] : []);` — no change needed.

- [ ] **Step 5: Type-check**

```bash
bunx tsc --noEmit
```

Fix any errors.

- [ ] **Step 6: Integration smoke test**

```bash
# Start daemon briefly, confirm it loads members and enters poll loop without crash
TELEGRAM_BOT_TOKEN=test TELEGRAM_CHAT_ID=123 VAULT_PATH=/vault timeout 3 bun run bin/tg-daemon.ts 2>&1 | tail -5
```

Expected last line: `priming complete, entering poll loop` (or a getUpdates network error, which is fine — it means startup succeeded).

- [ ] **Step 7: Commit**

```bash
git add bin/tg-daemon.ts
git commit -m "feat(daemon): quota enforcement, admin commands, per-channel dispatch"
```

---

## Task 6: Admin Telegram Commands Registration

**Files:**
- Modify: `bin/tg-set-commands.ts`

Register admin commands scoped to the admin's chat_id so they appear in the command menu only for admin.

- [ ] **Step 1: Update `bin/tg-set-commands.ts`**

Replace the entire file:

```typescript
#!/usr/bin/env bun
import { callApi } from "./lib/telegram";
import { loadMembers, getAdmin } from "./lib/members";

const GENERAL_COMMANDS = [
  { command: "stats", description: "查看 daemon 统计 / today's usage" },
];

const ADMIN_COMMANDS = [
  ...GENERAL_COMMANDS,
  { command: "list_members", description: "List all members and quota usage" },
  { command: "quota", description: "Check a member's quota: /quota alex" },
  { command: "reset_quota", description: "Reset a member's daily quota: /reset_quota alex" },
];

// Register general commands for all chats
await callApi("setMyCommands", {
  commands: GENERAL_COMMANDS,
  scope: { type: "default" },
});
console.log("registered general commands:");
for (const c of GENERAL_COMMANDS) console.log(`  /${c.command} — ${c.description}`);

// Register admin commands scoped to admin's chat_id
const members = loadMembers();
const admin = getAdmin(members);
if (admin) {
  await callApi("setMyCommands", {
    commands: ADMIN_COMMANDS,
    scope: { type: "chat", chat_id: admin.telegram_chat_id },
  });
  console.log(`\nregistered admin commands for chat_id ${admin.telegram_chat_id}:`);
  for (const c of ADMIN_COMMANDS) console.log(`  /${c.command} — ${c.description}`);
} else {
  console.log("\nNo admin.md found — skipping admin-scoped commands.");
}
```

- [ ] **Step 2: Verify it runs without error (needs real env)**

```bash
# Type-check only (no real Telegram call)
bunx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add bin/tg-set-commands.ts
git commit -m "feat: register admin Telegram commands scoped to admin chat_id"
```

---

## Task 7: Create Admin Member File

**Files:**
- Create: `vault/persona/members/admin.md` (runtime vault, not committed to repo)

- [ ] **Step 1: Create the members directory and admin file**

```bash
mkdir -p "$VAULT_PATH/persona/members"
cat > "$VAULT_PATH/persona/members/admin.md" << 'EOF'
---
name: Admin
telegram_chat_id: REPLACE_WITH_YOUR_CHAT_ID
telegram_user_id: REPLACE_WITH_YOUR_USER_ID
added_at: 2026-05-22
---
Team admin for VEX IQ 2026.
EOF
```

- [ ] **Step 2: Fill in real values**

Get your Telegram chat_id by messaging `@userinfobot` on Telegram. Get your user_id the same way (they are usually the same for private chats). Edit the file:

```bash
# Edit with your real IDs
nano "$VAULT_PATH/persona/members/admin.md"
```

- [ ] **Step 3: Verify daemon hot-reloads**

With the daemon running, save the file. Watch daemon logs for:

```
members reloaded: Admin
```

- [ ] **Step 4: Register commands**

```bash
VAULT_PATH=/vault bun run bin/tg-set-commands.ts
```

Expected:
```
registered general commands:
  /stats — 查看 daemon 统计 / today's usage

registered admin commands for chat_id <your-id>:
  /stats — ...
  /list_members — List all members and quota usage
  /quota — Check a member's quota: /quota alex
  /reset_quota — Reset a member's daily quota: /reset_quota alex
```

- [ ] **Step 5: Run full test suite**

```bash
bun test
```

Expected: all tests pass (members + quota).

- [ ] **Step 6: Final commit**

```bash
git add docs/
git commit -m "feat: multi-user family assistant — member registry, subprocess pool, quotas, admin commands"
```

---

## Spec Coverage Check

| Spec section | Task |
|---|---|
| Member registry (`vault/persona/members/*.md`) | Task 1, 7 |
| fs.watch hot-reload | Task 1 (`watchMembers`) |
| Per-chat subprocess pool | Task 4 |
| 30-min inactivity timeout | Task 4 (`startInactivityTimer`) |
| Per-channel PRIMING (DM + group) | Task 4 (`buildDmPriming`, `buildGroupPriming`) |
| Group identity injection (`from_name`, `member_role`) | Task 5 |
| Per-channel log paths (`dm-<id>/`, `group-<id>/`) | Task 4 |
| DM quota check + exceeded reply | Task 5 |
| Default quota (50) when unset | Task 2 |
| Admin always allowed (no quota) | Task 2 |
| `admin.md` filename = admin identity | Task 1 |
| `/list_members`, `/quota`, `/reset_quota` commands | Task 5, 6 |
| Scoped admin commands (`BotCommandScopeChat`) | Task 6 |
| Group chat quota-exempt | Task 5 (no quota check for group) |
| Unknown chat/user silently ignored | Task 3 |
| Shared KB accessible to all subprocesses | No code change needed — KB path is already in vault, PRIMING points there |
