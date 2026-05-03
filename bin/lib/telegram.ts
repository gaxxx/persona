const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) throw new Error("TELEGRAM_BOT_TOKEN not set in .env");

const API = `https://api.telegram.org/bot${TOKEN}`;

// --- Telegram Bot API ---

export async function callApi<T>(method: string, body?: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json()) as { ok: boolean; result: T; description?: string };
  if (!json.ok) throw new Error(`Telegram ${method}: ${json.description ?? res.statusText}`);
  return json.result;
}

export async function getUpdates(offset: number, timeout = 5) {
  return callApi<TelegramUpdate[]>("getUpdates", {
    offset,
    timeout,
    allowed_updates: ["message"],
  });
}

export async function sendTyping(chatId: number): Promise<void> {
  await callApi("sendChatAction", { chat_id: chatId, action: "typing" });
}

export async function sendMessage(chatId: number, text: string): Promise<void> {
  const html = markdownToTelegramHtml(text);
  const MAX = 4096;
  for (let i = 0; i < html.length; i += MAX) {
    try {
      await callApi("sendMessage", {
        chat_id: chatId,
        text: html.slice(i, i + MAX),
        parse_mode: "HTML",
      });
    } catch {
      // fallback to plain text if HTML fails
      await callApi("sendMessage", {
        chat_id: chatId,
        text: text.slice(i, i + MAX),
      });
    }
  }
}

export async function sendPhoto(chatId: number, filePath: string, caption?: string): Promise<void> {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("photo", Bun.file(filePath));
  if (caption) form.append("caption", caption);
  const res = await fetch(`${API}/sendPhoto`, { method: "POST", body: form });
  const json = (await res.json()) as { ok: boolean; description?: string };
  if (!json.ok) throw new Error(`Telegram sendPhoto: ${json.description}`);
}

export async function getFileUrl(fileId: string): Promise<string> {
  const file = await callApi<{ file_path: string }>("getFile", { file_id: fileId });
  return `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`;
}

export async function downloadFile(fileId: string, destPath: string): Promise<void> {
  const url = await getFileUrl(fileId);
  const res = await fetch(url);
  await Bun.write(destPath, res);
}

// --- Markdown to Telegram HTML (adapted from ClaudeClaw) ---

function markdownToTelegramHtml(text: string): string {
  if (!text) return "";

  // 1. Extract code blocks
  const codeBlocks: string[] = [];
  text = text.replace(/```[\w]*\n?([\s\S]*?)```/g, (_m, code) => {
    codeBlocks.push(code);
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });

  // 2. Extract inline code
  const inlineCodes: string[] = [];
  text = text.replace(/`([^`]+)`/g, (_m, code) => {
    inlineCodes.push(code);
    return `\x00IC${inlineCodes.length - 1}\x00`;
  });

  // 3. Strip markdown headers and blockquotes
  text = text.replace(/^#{1,6}\s+(.+)$/gm, "$1");
  text = text.replace(/^>\s*(.*)$/gm, "$1");

  // 4. Escape HTML
  text = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // 5. Links
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // 6. Bold
  text = text.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  text = text.replace(/__(.+?)__/g, "<b>$1</b>");

  // 7. Italic
  text = text.replace(/(?<![a-zA-Z0-9])_([^_]+)_(?![a-zA-Z0-9])/g, "<i>$1</i>");

  // 8. Strikethrough
  text = text.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // 9. Bullets
  text = text.replace(/^[-*]\s+/gm, "\u2022 ");

  // 10. Restore inline code
  for (let i = 0; i < inlineCodes.length; i++) {
    const escaped = inlineCodes[i].replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    text = text.replace(`\x00IC${i}\x00`, `<code>${escaped}</code>`);
  }

  // 11. Restore code blocks
  for (let i = 0; i < codeBlocks.length; i++) {
    const escaped = codeBlocks[i].replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    text = text.replace(`\x00CB${i}\x00`, `<pre><code>${escaped}</code></pre>`);
  }

  return text;
}

// --- Types ---

export interface TelegramMessage {
  message_id: number;
  from?: { id: number; first_name: string; username?: string; is_bot?: boolean };
  chat: { id: number; type: string };
  date: number;
  text?: string;
  caption?: string;
  photo?: { file_id: string }[];
  voice?: { file_id: string };
  document?: { file_id: string; file_name?: string; mime_type?: string };
  sticker?: { file_id: string; emoji?: string; is_animated?: boolean; is_video?: boolean };
  media_group_id?: string;
  reply_to_message?: TelegramMessage;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}
