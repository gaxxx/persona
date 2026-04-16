#!/usr/bin/env bun
import { sendTyping } from "./lib/telegram";

const chatId = Number(process.argv[2]);
if (!chatId) {
  console.error("Usage: bun run bin/tg-typing.ts <chat_id>");
  process.exit(1);
}

await sendTyping(chatId).catch(() => {});
