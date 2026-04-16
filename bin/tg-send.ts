#!/usr/bin/env bun
import { sendMessage } from "./lib/telegram";

const chatId = Number(process.argv[2]);
const text = process.argv[3] ?? (await Bun.stdin.text()).trim();

if (!chatId || !text) {
  console.error("Usage: bun run bin/tg-send.ts <chat_id> <text>");
  console.error("   or: echo 'text' | bun run bin/tg-send.ts <chat_id>");
  process.exit(1);
}

try {
  await sendMessage(chatId, text);
  console.log(JSON.stringify({ ok: true }));
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: (err as Error).message }));
  process.exit(1);
}
