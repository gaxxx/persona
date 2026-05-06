#!/usr/bin/env bun
import { sendMessage } from "./lib/telegram";

const chatId = Number(process.argv[2]);
const extra = process.argv.slice(3);

if (extra.length > 0) {
  console.error("tg-send: body must come from stdin. Use: echo '...' | bun run bin/tg-send.ts <chat_id>");
  process.exit(1);
}

const text = (await Bun.stdin.text()).trim();

if (!chatId || !text) {
  console.error("Usage: echo '...' | bun run bin/tg-send.ts <chat_id>");
  process.exit(1);
}

try {
  await sendMessage(chatId, text);
  console.log(JSON.stringify({ ok: true }));
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: (err as Error).message }));
  process.exit(1);
}
