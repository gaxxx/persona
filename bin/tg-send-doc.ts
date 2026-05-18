#!/usr/bin/env bun
// tg-send-doc.ts — send any file to a Telegram chat as a Document (no
// compression, preserves resolution). Use this — NOT tg-send-photo.ts —
// for engineering drawings, dimensional diagrams, HTML/SVG/PDF, or any
// image where readable fine-print labels matter.
//
// Usage:
//   bun run bin/tg-send-doc.ts <chat_id> <file_path> [caption]
//   echo "caption" | bun run bin/tg-send-doc.ts <chat_id> <file_path> -
//
// MIME type is auto-detected from the file extension. Override with the
// TG_SEND_DOC_MIME env var (rare).
//
// Why: sendPhoto compresses + downscales (kills dimension labels);
// sendDocument uploads as-is. For HTML/PDF/SVG, MIME also controls
// whether Telegram opens it in a browser/viewer or saves to Files.

import { sendDocument } from "./lib/telegram";

const MIME_BY_EXT: Record<string, string> = {
  ".html": "text/html",
  ".htm":  "text/html",
  ".svg":  "image/svg+xml",
  ".pdf":  "application/pdf",
  ".json": "application/json",
  ".md":   "text/markdown",
  ".txt":  "text/plain",
  // PNG/JPG: don't override — Telegram identifies these correctly.
  // We still go through sendDocument so they're uploaded without
  // sendPhoto's compression.
};

const [chatId, filePath, ...rest] = process.argv.slice(2);

if (!chatId || !filePath) {
  console.error("Usage: bun run bin/tg-send-doc.ts <chat_id> <file_path> [caption]");
  console.error("   or: echo 'caption' | bun run bin/tg-send-doc.ts <chat_id> <file_path> -");
  process.exit(1);
}

// Resolve caption: argv (joined) wins; if argv is "-" or empty, try stdin.
let caption: string | undefined = rest.join(" ").trim() || undefined;
if (caption === "-" || (!caption && !process.stdin.isTTY)) {
  caption = (await Bun.stdin.text()).trim() || undefined;
}

const ext = (filePath.toLowerCase().match(/\.[^.\/]+$/) ?? [""])[0];
const mime = process.env.TG_SEND_DOC_MIME || MIME_BY_EXT[ext];

try {
  await sendDocument(Number(chatId), filePath, caption, mime);
  console.log(JSON.stringify({ ok: true }));
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: (err as Error).message }));
  process.exit(1);
}
