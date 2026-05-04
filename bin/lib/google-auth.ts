/**
 * google-auth.ts — token loader for ~/.gmail-mcp/credentials.json with
 * auto-refresh. Used by direct Google API callers (Calendar, Gmail) when
 * we want to bypass the MCP server.
 *
 * Persists the refreshed access_token + expiry_date back to disk so the
 * gmail-mcp server (which reads the same file) stays in sync.
 */
import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

interface OAuthKeys {
  installed: { client_id: string; client_secret: string };
}
interface Creds {
  access_token: string;
  expiry_date: number;
  refresh_token: string;
  scope: string;
  token_type: string;
}

const HOME = process.env.HOME ?? "";
const KEYS_PATH = resolve(HOME, ".gmail-mcp/gcp-oauth.keys.json");
const CREDS_PATH = resolve(HOME, ".gmail-mcp/credentials.json");

const REFRESH_LEEWAY_MS = 60 * 1000; // refresh if <60s left

/**
 * Returns true iff ~/.gmail-mcp/credentials.json exists and its `scope`
 * field contains the given Google API scope. Use this for graceful-degrade
 * checks before hitting an API directly — lets a clean clone exit silently
 * instead of throwing 401s when nobody has run gauth-reauth.ts yet.
 */
export function hasGoogleScope(scope: string): boolean {
  if (!existsSync(CREDS_PATH)) return false;
  try {
    const creds = JSON.parse(readFileSync(CREDS_PATH, "utf8")) as { scope?: string };
    return typeof creds.scope === "string" && creds.scope.split(/\s+/).includes(scope);
  } catch {
    return false;
  }
}

export async function getAccessToken(): Promise<string> {
  const creds: Creds = JSON.parse(readFileSync(CREDS_PATH, "utf8"));
  const now = Date.now();
  if (creds.expiry_date - now > REFRESH_LEEWAY_MS) {
    return creds.access_token;
  }

  const keys: OAuthKeys = JSON.parse(readFileSync(KEYS_PATH, "utf8"));
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: keys.installed.client_id,
      client_secret: keys.installed.client_secret,
      refresh_token: creds.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    throw new Error(`token refresh failed: ${res.status} ${await res.text()}`);
  }
  const tok = (await res.json()) as {
    access_token: string;
    expires_in: number;
    scope?: string;
    token_type?: string;
  };
  const updated: Creds = {
    ...creds,
    access_token: tok.access_token,
    expiry_date: Date.now() + tok.expires_in * 1000,
    scope: tok.scope ?? creds.scope,
    token_type: tok.token_type ?? creds.token_type,
  };
  writeFileSync(CREDS_PATH, JSON.stringify(updated, null, 2));
  return tok.access_token;
}
