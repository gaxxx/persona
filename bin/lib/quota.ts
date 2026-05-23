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
