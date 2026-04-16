#!/usr/bin/env bun
import { getUpdates, type TelegramUpdate } from "./lib/telegram";
import { mkdirSync, existsSync } from "fs";

const OFFSET_FILE = "data/tg-offset.json";

// Ensure data dir exists
if (!existsSync("data")) mkdirSync("data", { recursive: true });

// Read last offset
let offset = 0;
try {
  const saved = await Bun.file(OFFSET_FILE).json();
  offset = saved.offset ?? 0;
} catch {
  // first run
}

// Pull updates (short timeout since loop controls pacing)
const updates = await getUpdates(offset, 5);

// Extract messages
const messages = updates
  .filter((u: TelegramUpdate) => u.message?.text)
  .map((u: TelegramUpdate) => ({
    chat_id: u.message!.chat.id,
    from: u.message!.from
      ? `${u.message!.from.first_name}${u.message!.from.username ? ` (@${u.message!.from.username})` : ""}`
      : "unknown",
    text: u.message!.text,
    date: new Date(u.message!.date * 1000).toISOString(),
    message_id: u.message!.message_id,
  }));

// Update offset
if (updates.length > 0) {
  const newOffset = Math.max(...updates.map((u) => u.update_id)) + 1;
  await Bun.write(OFFSET_FILE, JSON.stringify({ offset: newOffset }));
}

// Output to stdout for Claude Code to read
console.log(JSON.stringify(messages, null, 2));
