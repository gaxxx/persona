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
