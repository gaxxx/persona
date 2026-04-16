#!/usr/bin/env bun
/**
 * Long-running watcher: polls Telegram every 5s, prints new messages to stdout.
 * Designed to be run via Claude Code's Monitor tool.
 * Each line of stdout is a JSON message that wakes the loop.
 */
import { getUpdates, type TelegramUpdate } from "./lib/telegram";
import { mkdirSync, existsSync } from "fs";

const OFFSET_FILE = "data/tg-offset.json";
const POLL_INTERVAL = 5_000; // 5 seconds

if (!existsSync("data")) mkdirSync("data", { recursive: true });

// Read last offset
let offset = 0;
try {
  const saved = await Bun.file(OFFSET_FILE).json();
  offset = saved.offset ?? 0;
} catch {
  // first run
}

// Poll forever
while (true) {
  try {
    const updates = await getUpdates(offset, 3);

    for (const u of updates) {
      offset = u.update_id + 1;
      if (!u.message?.text) continue;

      const msg = {
        chat_id: u.message.chat.id,
        from: u.message.from
          ? `${u.message.from.first_name}${u.message.from.username ? ` (@${u.message.from.username})` : ""}`
          : "unknown",
        text: u.message.text,
        date: new Date(u.message.date * 1000).toISOString(),
        message_id: u.message.message_id,
      };

      // Each line wakes the Monitor → wakes the loop
      console.log(JSON.stringify(msg));
    }

    // Persist offset after processing
    if (updates.length > 0) {
      await Bun.write(OFFSET_FILE, JSON.stringify({ offset }));
    }
  } catch (err) {
    console.error(`[tg-watch] ${(err as Error).message}`);
  }

  await Bun.sleep(POLL_INTERVAL);
}
