# bsession integration

persona can drive a [bsession](https://github.com/gaxxx/bsession) headed browser
(Cloudflare/CAPTCHA-aware, persistent cookies) running in a separate
`agent-browser` container, and hand text-entry CAPTCHAs to you over Telegram.

bsession ships as a **Claude Code plugin**: a `bsession` shim on the Bash `PATH`
that forwards CLI commands to the bsession HTTP API (`POST /cli`). persona enables
it **at runtime via `settings.json`** — no docker-compose wiring, no host-path
mount.

## Enable (runtime, via `.claude/settings.json`)

`.claude/settings.json` is gitignored, so add this locally (alongside any
existing entries). The plugin is fetched from the public GitHub repo on session
start — same mechanism persona already uses for `frontend-design`:

```json
{
  "extraKnownMarketplaces": {
    "bsession-marketplace": {
      "source": { "source": "github", "repo": "gaxxx/bsession" }
    }
  },
  "enabledPlugins": {
    "bsession@bsession-marketplace": true
  }
}
```

No `claude plugin install` step, no `docker-compose.yml` change. The shim defaults
`BSESSION_API_URL` to `http://host.docker.internal:18000`; set that env only if
the engine lives elsewhere.

> The github source resolves the repo's **default branch (`main`)**, so the
> plugin must be merged to `main` first. Until then, enable it from a local
> checkout instead: `"source": { "source": "directory", "path": "/abs/path/to/bsession" }`
> (mount that path into the container if persona runs in Docker).

## Prerequisite: the engine must be running

Primitives talk to the `agent-browser` container's API on port 18000. **persona's
container has no Docker access, so it can't start the engine itself** — run it on
the host:

```bash
git clone https://github.com/gaxxx/bsession ~/playground/bsession   # once
cd ~/playground/bsession && docker compose up -d --build
curl -fsS http://localhost:18000/health      # → {"status":"ok"}
```

The bsession skill's own Setup section documents this health-check + bootstrap;
on a host *with* Docker it can self-bootstrap.

## How it works

- persona's skills call bare `bsession ...`; the plugin's shim posts to
  `$BSESSION_API_URL/cli`, which runs the per-profile CLI in the engine
  container. Forms in persona's repo are staged across by the shim, so per-skill
  cookies/profiles work unchanged.

## CAPTCHA hand-off (text-entry → Telegram)

cloak auto-resolves non-interactive Turnstile. For a real challenge, the bsession
skill spec documents a channel-agnostic hand-off; persona implements the Telegram
channel with tools it already has:

1. `bsession captcha screenshot --output /tmp/c.png` (or
   `GET $BSESSION_API_URL/captcha/screenshot?profile=<p>`).
2. Look at the image. **Text-entry** → send it to you and wait for the typed
   answer; **click-grid/interactive** → send the VNC URL
   (`$BSESSION_VNC_URL`, default `http://localhost:6080/vnc.html`) for manual solve.
3. `bun run bin/tg-send-photo.ts "$TELEGRAM_CHAT_ID" /tmp/c.png "Solve this captcha; reply with the text."`
4. Poll `bin/tg-pull.ts` for your reply, then `bsession fill <ref> "<answer>"` and submit.
5. Wrong answer → retry up to 2×; timeout or grid → VNC fallback.
