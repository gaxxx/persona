#!/usr/bin/env bun
/**
 * gauth-reauth.ts — one-off OAuth re-grant for ~/.gmail-mcp/credentials.json.
 *
 * Adds `calendar.readonly` to the existing Gmail scopes so wrappers like
 * bin/upcoming.ts can hit Google Calendar API directly (no `claude -p`).
 *
 * Two-step flow (avoids needing localhost reachable from the host browser):
 *
 *   Step 1:  bun run bin/gauth-reauth.ts
 *            -> prints the auth URL. Open it in your browser, sign in,
 *               grant all 3 scopes. Browser will fail to load
 *               `localhost:3000/oauth2callback?code=...` — that's fine.
 *               Copy the FULL URL from the address bar.
 *
 *   Step 2:  bun run bin/gauth-reauth.ts '<pasted URL>'
 *            -> extracts the code, exchanges it for tokens, writes
 *               ~/.gmail-mcp/credentials.json. Both Gmail and Calendar
 *               will work afterwards.
 *
 * Resulting credentials match the format gmail-mcp expects, so the Gmail
 * MCP server keeps working.
 */
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

const HOME = process.env.HOME;
if (!HOME) {
  console.error("HOME env var not set");
  process.exit(1);
}

const KEYS_PATH = resolve(HOME, ".gmail-mcp/gcp-oauth.keys.json");
const CREDS_PATH = resolve(HOME, ".gmail-mcp/credentials.json");
const REDIRECT_URI = "http://localhost:3000/oauth2callback";
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.settings.basic",
  "https://www.googleapis.com/auth/calendar.readonly",
];

interface OAuthKeys {
  installed: { client_id: string; client_secret: string };
}

const keys: OAuthKeys = JSON.parse(readFileSync(KEYS_PATH, "utf8"));
const clientId = keys.installed.client_id;
const clientSecret = keys.installed.client_secret;

const pasted = process.argv[2];

if (!pasted) {
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", REDIRECT_URI);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", SCOPES.join(" "));
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  console.log("\n=== Step 1: open this URL in your browser ===\n");
  console.log(u.toString());
  console.log(
    "\nSign in, grant all 3 scopes. Browser will fail to load\n" +
      "localhost:3000/oauth2callback — that's fine. Copy the FULL URL\n" +
      "from the address bar, then run:\n\n" +
      "  bun run bin/gauth-reauth.ts '<pasted URL>'\n",
  );
  process.exit(0);
}

let code: string | null = null;
try {
  code = new URL(pasted).searchParams.get("code");
} catch (err) {
  console.error("Pasted argument is not a URL:", (err as Error).message);
  process.exit(1);
}
if (!code) {
  console.error("No `code` query param in pasted URL");
  process.exit(1);
}

const res = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: REDIRECT_URI,
    grant_type: "authorization_code",
  }),
});

if (!res.ok) {
  console.error("Token exchange failed:", res.status, await res.text());
  process.exit(1);
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
  token_type: string;
}
const tok = (await res.json()) as TokenResponse;

if (!tok.refresh_token) {
  console.error(
    "No refresh_token returned — Google only sends it on first consent.\n" +
      "Re-run step 1 (URL includes prompt=consent which should force it),\n" +
      "or revoke at https://myaccount.google.com/permissions and retry.",
  );
  process.exit(1);
}

writeFileSync(
  CREDS_PATH,
  JSON.stringify(
    {
      access_token: tok.access_token,
      expiry_date: Date.now() + tok.expires_in * 1000,
      refresh_token: tok.refresh_token,
      scope: tok.scope,
      token_type: tok.token_type,
    },
    null,
    2,
  ),
);

console.log("\nWrote", CREDS_PATH);
console.log("Granted scopes:", tok.scope);

const gmail = await fetch(
  "https://gmail.googleapis.com/gmail/v1/users/me/profile",
  { headers: { Authorization: `Bearer ${tok.access_token}` } },
);
const cal = await fetch(
  "https://www.googleapis.com/calendar/v3/calendars/primary",
  { headers: { Authorization: `Bearer ${tok.access_token}` } },
);
console.log(
  `Gmail probe: ${gmail.ok ? "ok" : "FAIL"} (${gmail.ok ? ((await gmail.json()) as { emailAddress: string }).emailAddress : ""})`,
);
console.log(
  `Calendar probe: ${cal.ok ? "ok" : "FAIL"} (${cal.ok ? ((await cal.json()) as { id: string }).id : ""})`,
);
