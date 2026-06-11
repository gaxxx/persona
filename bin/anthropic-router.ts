#!/usr/bin/env bun
/**
 * bin/anthropic-router.ts — Split-upstream Anthropic proxy.
 *
 * Text-only  → DeepSeek Anthropic-native API — prefix caching, tool use
 * Image/text → OpenRouter (Anthropic format pass-through) — vision capable
 *
 * Run: bun run bin/anthropic-router.ts
 *
 * Required env vars:
 *   DEEPSEEK_API_KEY    — DeepSeek API key
 *   OPENROUTER_API_KEY  — OpenRouter API key (vision path)
 *   ROUTER_TEXT_MODEL   — DeepSeek model name (default: deepseek-v4-pro)
 *   ROUTER_VISION_MODEL — Vision model via OpenRouter (default: xiaomi/mimo-v2.5)
 *   ROUTER_PORT         — listen port (default: 8787)
 */

const DEEPSEEK_BASE   = "https://api.deepseek.com/anthropic";
const OPENROUTER_BASE = "https://openrouter.ai/api";

const DEEPSEEK_KEY  = process.env.DEEPSEEK_API_KEY;
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const TEXT_MODEL   = process.env.ROUTER_TEXT_MODEL   || "deepseek-v4-pro";
const VISION_MODEL = process.env.ROUTER_VISION_MODEL || "xiaomi/mimo-v2.5";
const PORT = parseInt(process.env.ROUTER_PORT || "8787", 10);

if (!DEEPSEEK_KEY)   { console.error("FATAL: DEEPSEEK_API_KEY must be set");   process.exit(1); }
if (!OPENROUTER_KEY) { console.error("FATAL: OPENROUTER_API_KEY must be set"); process.exit(1); }

type AntBlock = { type: string; [k: string]: unknown };
type AntMsg   = { role: string; content: string | AntBlock[] };

function hasImage(messages: AntMsg[]): boolean {
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const b of msg.content) {
      if (b.type === "image") return true;
    }
  }
  return false;
}

function proxyHeaders(req: Request, authKey: string, extra?: Record<string, string>): Headers {
  const h = new Headers();
  for (const name of ["content-type", "anthropic-version", "anthropic-beta"]) {
    const v = req.headers.get(name);
    if (v) h.set(name, v);
  }
  h.set("authorization", `Bearer ${authKey}`);
  if (extra) for (const [k, v] of Object.entries(extra)) h.set(k, v);
  return h;
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const rawBody = await req.text().catch(() => "");

    // Non-messages endpoints → DeepSeek pass-through
    if (req.method !== "POST" || url.pathname !== "/v1/messages") {
      return fetch(`${DEEPSEEK_BASE}${url.pathname}${url.search}`, {
        method: req.method,
        headers: proxyHeaders(req, DEEPSEEK_KEY!),
        body: rawBody || undefined,
      });
    }

    let body: any;
    try { body = JSON.parse(rawBody); } catch {
      return new Response("invalid JSON", { status: 400 });
    }

    const vision = hasImage(body?.messages ?? []);
    body.model = vision ? VISION_MODEL : TEXT_MODEL;

    console.log(
      `[${new Date().toISOString()}] ${vision ? "🖼 vision" : "✏ text  "} → ${body.model}${body.stream ? " (stream)" : ""}`,
    );

    const [upstream, key, extra] = vision
      ? [OPENROUTER_BASE, OPENROUTER_KEY!, { "HTTP-Referer": "http://localhost:8787", "X-Title": "persona-anthropic-router" }]
      : [DEEPSEEK_BASE,   DEEPSEEK_KEY!,   {}];

    const res = await fetch(`${upstream}/v1/messages`, {
      method: "POST",
      headers: proxyHeaders(req, key, extra),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => "");
      console.error(`${vision ? "vision" : "text"} upstream ${res.status}: ${err.slice(0, 400)}`);
      return new Response(err, { status: res.status, headers: { "content-type": "application/json" } });
    }

    return res;
  },
});

console.log(`router on http://localhost:${PORT}`);
console.log(`  ✏ text   → DeepSeek Anthropic (${TEXT_MODEL})`);
console.log(`  🖼 vision → OpenRouter (${VISION_MODEL})`);
