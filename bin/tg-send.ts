#!/usr/bin/env bun
import { sendMessage } from "./lib/telegram";

const chatId = Number(process.argv[2]);
// Join all argv from index 3 onward to survive accidental bash word-splitting
// when the caller's quoted string contains an unescaped " (which terminates
// the outer quote and splits the rest into separate argv entries).
const argvText = process.argv.slice(3).join(" ").trim();
const text = argvText || (await Bun.stdin.text()).trim();

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
