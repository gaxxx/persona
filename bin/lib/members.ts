import { readdirSync, readFileSync, watch } from "fs";
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
      meta[m[1]] = val === "" || isNaN(Number(val)) ? val : Number(val);
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
    // directory may not exist yet
  }
}
