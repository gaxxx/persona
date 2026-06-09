#!/usr/bin/env bun
/**
 * bin/anthropic-router.ts — Anthropic Messages API proxy via OpenRouter.
 * Routes by content: has image → vision model, text-only → text model.
 *
 * Run: bun run bin/anthropic-router.ts
 *
 * Required env vars:
 *   OPENROUTER_API_KEY
 *   ROUTER_TEXT_MODEL   — text model (default: deepseek/deepseek-v4-pro)
 *   ROUTER_VISION_MODEL — vision model (default: xiaomi/mimo-v2.5)
 *   ROUTER_PORT         — listen port (default: 8787)
 */

const OPENROUTER = "https://openrouter.ai/api";

const API_KEY = process.env.OPENROUTER_API_KEY;
const TEXT_MODEL = process.env.ROUTER_TEXT_MODEL || "deepseek/deepseek-v4-pro";
const VISION_MODEL = process.env.ROUTER_VISION_MODEL || "xiaomi/mimo-v2.5";
const PORT = parseInt(process.env.ROUTER_PORT || "8787", 10);

if (!API_KEY) {
  console.error("FATAL: OPENROUTER_API_KEY must be set");
  process.exit(1);
}

function hasImage(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false;
  for (const msg of messages) {
    const content = msg?.content;
    if (typeof content === "string") continue;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === "image") return true;
      }
    }
  }
  return false;
}

function headers(): Headers {
  const h = new Headers();
  h.set("content-type", "application/json");
  h.set("authorization", `Bearer ${API_KEY}`);
  h.set("HTTP-Referer", "http://localhost:8787");
  h.set("X-Title", "persona-anthropic-router");
  return h;
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // Read body once — Bun's Request.clone() is unreliable for body streams
    const rawBody = await req.text().catch(() => "");

    // Pass through non-/v1/messages requests
    if (req.method !== "POST" || path !== "/v1/messages") {
      const upstream = `${OPENROUTER}${path}${url.search}`;
      return fetch(upstream, {
        method: req.method,
        headers: headers(),
        body: rawBody || undefined,
      });
    }

    // --- /v1/messages: check for images, swap model ---
    let body: any;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return new Response("invalid JSON", { status: 400 });
    }

    const usesVision = hasImage(body?.messages);
    body.model = usesVision ? VISION_MODEL : TEXT_MODEL;

    console.log(
      `[${new Date().toISOString()}] ${usesVision ? "🖼 vision" : "✏ text "} → ${body.model}`,
    );

    const res = await fetch(`${OPENROUTER}/v1/messages`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error(`[${new Date().toISOString()}] upstream ${res.status}: ${errText.slice(0, 500)}`);
    }
    return res;
  },
});

console.log(`router → OpenRouter on http://localhost:${PORT}`);
console.log(`  text   → ${TEXT_MODEL}`);
console.log(`  vision → ${VISION_MODEL}`);
