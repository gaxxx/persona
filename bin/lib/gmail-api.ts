#!/usr/bin/env bun
/**
 * gmail-api.ts — a small, dependency-free direct Gmail REST client.
 *
 * Why this exists: the gmail-digest cron used to reach Gmail through the
 * `@gongrzhe/server-gmail-autoauth-mcp` MCP server, which each `claude -p`
 * subprocess re-booted via `npx` — re-doing the OAuth handshake every step.
 * That cold start intermittently flaked (network / rate-limit / npx resolve),
 * so the `search` tool errored and the run was skipped. It was NOT a token
 * expiry problem — the token refreshes fine.
 *
 * The fix: skip MCP entirely for Gmail I/O. This module talks to the Gmail
 * REST API directly from TypeScript using the OAuth refresh token already on
 * disk (written by the MCP server's original auth flow). The LLM then only
 * does pure-text reasoning with no tool access, so it can't flake on a call.
 *
 * Credentials live in `~/.gmail-mcp/` (override the dir with GMAIL_MCP_DIR):
 *   - credentials.json    OAuth token store {access_token, expiry_date(ms),
 *                         refresh_token, scope, token_type}
 *   - gcp-oauth.keys.json {installed:{client_id, client_secret, token_uri,...}}
 *
 * No npm deps — uses Bun's global fetch. Never logs or prints secret values.
 */
import { existsSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { resolve } from "path";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

function mcpDir(): string {
  return process.env.GMAIL_MCP_DIR || resolve(homedir(), ".gmail-mcp");
}

interface Credentials {
  access_token: string;
  expiry_date?: number; // ms epoch when access_token expires
  refresh_token: string;
  scope?: string;
  token_type?: string;
}

interface OAuthKeys {
  installed: {
    client_id: string;
    client_secret: string;
    token_uri: string;
  };
}

function readJson<T>(path: string, label: string): T {
  if (!existsSync(path)) {
    throw new Error(`Gmail ${label} not found at ${path} — re-run the Gmail OAuth setup.`);
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (err) {
    throw new Error(`Gmail ${label} at ${path} is not valid JSON: ${(err as Error).message}`);
  }
}

/**
 * Return a valid access token, refreshing + persisting it when it's missing or
 * within 120s of expiry. Refresh uses the standard installed-app OAuth flow;
 * Google does not return the refresh_token on refresh, so we preserve it.
 */
export async function getAccessToken(): Promise<string> {
  const dir = mcpDir();
  const credPath = resolve(dir, "credentials.json");
  const cred = readJson<Credentials>(credPath, "credentials.json");

  const skewMs = 120 * 1000;
  const stillValid =
    typeof cred.expiry_date === "number" && cred.expiry_date - Date.now() > skewMs;
  if (stillValid && cred.access_token) return cred.access_token;

  const keys = readJson<OAuthKeys>(resolve(dir, "gcp-oauth.keys.json"), "gcp-oauth.keys.json");
  const { client_id, client_secret, token_uri } = keys.installed;

  const body = new URLSearchParams({
    client_id,
    client_secret,
    refresh_token: cred.refresh_token,
    grant_type: "refresh_token",
  });
  const res = await fetch(token_uri || "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    // Body may contain error detail but never the token; safe-ish, but keep it short.
    const detail = (await res.text()).slice(0, 200);
    throw new Error(`Gmail token refresh failed (HTTP ${res.status}): ${detail}`);
  }
  const json = (await res.json()) as { access_token: string; expires_in: number };
  const updated: Credentials = {
    ...cred,
    access_token: json.access_token,
    expiry_date: Date.now() + json.expires_in * 1000,
  };
  writeFileSync(credPath, JSON.stringify(updated, null, 2));
  return json.access_token;
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getAccessToken();
  return { Authorization: `Bearer ${token}` };
}

async function gmailGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { headers: await authHeaders() });
  if (!res.ok) {
    throw new Error(`Gmail GET ${path.split("?")[0]} failed (HTTP ${res.status})`);
  }
  return (await res.json()) as T;
}

interface GmailHeader {
  name: string;
  value: string;
}
interface GmailPart {
  mimeType?: string;
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
}
interface GmailMessage {
  id: string;
  snippet?: string;
  payload?: GmailPart & { headers?: GmailHeader[] };
}

function headerVal(headers: GmailHeader[] | undefined, name: string): string {
  const h = headers?.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h?.value ?? "";
}

/**
 * Search messages. Returns the array of message ids (empty array if the inbox
 * matched nothing — a 200 with no `messages`). Throws on non-200 so a caller
 * can tell a real outage from an empty result.
 */
export async function searchMessageIds(query: string, maxResults: number): Promise<string[]> {
  const json = await gmailGet<{ messages?: { id: string }[]; resultSizeEstimate?: number }>(
    `/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`,
  );
  if (!Array.isArray(json.messages)) return [];
  return json.messages.map((m) => m.id);
}

// Run an async mapper over items with a bounded concurrency, preserving order.
async function mapPool<I, O>(items: I[], limit: number, fn: (item: I) => Promise<O>): Promise<O[]> {
  const out: O[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return out;
}

/** Fetch From/Subject headers for each id (concurrency-capped, order preserved). */
export async function getHeaders(
  ids: string[],
): Promise<{ id: string; from: string; subject: string }[]> {
  return mapPool(ids, 8, async (id) => {
    const msg = await gmailGet<GmailMessage>(
      `/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`,
    );
    const headers = msg.payload?.headers;
    return { id, from: headerVal(headers, "From"), subject: headerVal(headers, "Subject") };
  });
}

// Decode Gmail's base64url-encoded body data.
function decodeB64Url(data: string): string {
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
  try {
    return Buffer.from(b64 + pad, "base64").toString("utf8");
  } catch {
    return "";
  }
}

// Walk the MIME tree, preferring text/plain, falling back to text/html.
function extractBody(payload: GmailPart | undefined): string {
  if (!payload) return "";
  const plain = findPart(payload, "text/plain");
  if (plain) return decodeB64Url(plain);
  const html = findPart(payload, "text/html");
  if (html) return stripHtml(decodeB64Url(html));
  return "";
}

function findPart(part: GmailPart, mime: string): string | null {
  if (part.mimeType === mime && part.body?.data) return part.body.data;
  for (const p of part.parts ?? []) {
    const found = findPart(p, mime);
    if (found) return found;
  }
  return null;
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

const BODY_CAP = 4000;

/** Fetch a single message's From/Subject and decoded text body (capped ~4000 chars). */
export async function getBody(id: string): Promise<{ from: string; subject: string; body: string }> {
  const msg = await gmailGet<GmailMessage>(`/messages/${id}?format=full`);
  const headers = msg.payload?.headers;
  let body = extractBody(msg.payload);
  if (!body) body = msg.snippet ?? "";
  if (body.length > BODY_CAP) body = body.slice(0, BODY_CAP) + "…";
  return { from: headerVal(headers, "From"), subject: headerVal(headers, "Subject"), body };
}

/** Add/remove labels on a batch of messages. No-op if ids empty. Throws on non-200. */
export async function batchModify(
  ids: string[],
  addLabelIds: string[],
  removeLabelIds: string[],
): Promise<void> {
  if (ids.length === 0) return;
  const res = await fetch(`${API}/messages/batchModify`, {
    method: "POST",
    headers: { ...(await authHeaders()), "Content-Type": "application/json" },
    body: JSON.stringify({ ids, addLabelIds, removeLabelIds }),
  });
  if (!res.ok) {
    throw new Error(`Gmail batchModify failed (HTTP ${res.status})`);
  }
}

/**
 * Send a plain-text email. Builds an RFC 2822 message, base64url-encodes it,
 * and POSTs to messages/send. `to` may be a string or an array of addresses.
 * Returns the sent message id.
 */
export async function sendEmail(opts: {
  to: string | string[];
  subject: string;
  body: string;
}): Promise<string> {
  const to = Array.isArray(opts.to) ? opts.to.join(", ") : opts.to;
  // Encode non-ASCII subjects per RFC 2047 so headers stay 7-bit clean.
  const subject = /[^\x00-\x7F]/.test(opts.subject)
    ? `=?UTF-8?B?${Buffer.from(opts.subject, "utf8").toString("base64")}?=`
    : opts.subject;
  const message = [
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(opts.body, "utf8").toString("base64"),
  ].join("\r\n");
  const raw = Buffer.from(message, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const res = await fetch(`${API}/messages/send`, {
    method: "POST",
    headers: { ...(await authHeaders()), "Content-Type": "application/json" },
    body: JSON.stringify({ raw }),
  });
  if (!res.ok) {
    throw new Error(`Gmail send failed (HTTP ${res.status})`);
  }
  const json = (await res.json()) as { id: string };
  return json.id;
}

// ---------------------------------------------------------------------------
// CLI smoke test — guarded so importing this module has no side effects.
// Output is kept free of secrets (never prints the token).
// ---------------------------------------------------------------------------
if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd === "token") {
      await getAccessToken();
      const cred = readJson<Credentials>(resolve(mcpDir(), "credentials.json"), "credentials.json");
      const iso = cred.expiry_date ? new Date(cred.expiry_date).toISOString() : "unknown";
      console.log(`ok, expires ${iso}`);
    } else if (cmd === "search") {
      const query = rest[0] || "is:unread in:inbox";
      const max = rest[1] ? parseInt(rest[1], 10) : 5;
      const ids = await searchMessageIds(query, max);
      if (ids.length === 0) {
        console.log("0 results");
      } else {
        const headers = await getHeaders(ids);
        for (const h of headers) {
          console.log(`${h.id}\t${h.from}\t${h.subject}`);
        }
      }
    } else if (cmd === "body") {
      const b = await getBody(rest[0]);
      console.log(`From: ${b.from}\nSubject: ${b.subject}\n\n${b.body}`);
    } else {
      console.log("usage: gmail-api.ts <token|search [query] [n]|body <id>>");
      process.exit(1);
    }
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
