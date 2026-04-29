import { sendPhoto } from "./lib/telegram";

const [chatId, filePath, ...captionParts] = process.argv.slice(2);
if (!chatId || !filePath) {
  console.error("Usage: bun run bin/tg-send-photo.ts <chat_id> <file_path> [caption]");
  process.exit(1);
}

const caption = captionParts.join(" ") || undefined;
await sendPhoto(Number(chatId), filePath, caption);
console.log(JSON.stringify({ ok: true }));
