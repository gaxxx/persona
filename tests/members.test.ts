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

  test("treats whitespace-only frontmatter value as string not number", () => {
    writeFileSync(
      `${TEST_VAULT}/persona/members/ws.md`,
      `---\nname: WS\ntelegram_chat_id: 111\ntelegram_user_id: 222\nrole: \n---`,
    );
    const [m] = loadMembers();
    // role should be the trimmed string "" or undefined, NOT the number 0
    expect(typeof m.role).not.toBe("number");
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
