# Multi-User Family Assistant — Design Spec

**Date:** 2026-05-22  
**Context:** Evolve the single-user personal assistant into a shared assistant for a 10-person family team participating in the VEX IQ 2026 competition.

---

## Goals

1. Shared knowledge base accessible to all members
2. 1:1 private DM conversations with each member (with daily quota)
3. Shared group channel where all members can talk to the bot
4. Admin controls for managing members and quotas

---

## 1. Member Registry

Members are stored as individual files in the vault:

```
vault/persona/members/
  admin.md
  alex.md
  mia.md
  ...
```

Each file uses frontmatter:

```yaml
---
name: Alex
telegram_chat_id: 12345678     # DM chat_id (bot ↔ member private chat)
telegram_user_id: 87654321     # Telegram user ID (for group message identification)
role: driver                   # optional: vex role (driver/builder/programmer/coach/etc)
daily_dm_quota: 50             # optional: max DM messages/day; omit = unlimited
added_at: 2026-01-01
---
Optional notes about this member.
```

**Required fields:** `name`, `telegram_chat_id`, `telegram_user_id`  
**Optional fields:** `role`, `daily_dm_quota`, free-text notes body

**Admin member** (`admin.md`) has no `daily_dm_quota` — quota check is always skipped for admin. The daemon identifies the admin by the exact filename `admin.md` (not by any field value). This `chat_id` is used to scope admin Telegram commands.

**Lifecycle:** Admin manages files directly (create = add access, delete = remove access). The daemon watches `vault/persona/members/` via `fs.watch` with a 500ms debounce and reloads the registry on any change — same pattern as CRON.md reload. No daemon restart needed.

**Default quota:** If `daily_dm_quota` is absent for a non-admin member, the daemon applies a configurable default (initially 50 messages/day, defined as `DEFAULT_DM_QUOTA` in `tg-daemon.ts`).

The existing `vault/persona/USER.md` is retained as the admin's personal profile for backward compatibility with existing personal assistant features.

---

## 2. Subprocess Pool & Routing

The daemon maintains a lazy subprocess pool:

```
Map<chat_id: number, SubprocessHandle>
```

**Key:** `chat_id` — unique per conversation channel:
- Each member's DM with the bot → their own `chat_id`
- The group chat → the group's `chat_id`

**Spawn:** On first message to a `chat_id`, spawn a fresh `claude -p` subprocess and send it a channel-specific PRIMING (see below).

**Inactivity timeout:** 30 minutes after the last message on a channel. On expiry, kill the subprocess. The next message triggers a cold respawn.

**Group message identity:** Telegram group messages include `from.id`. The daemon resolves `from.id` → member profile and injects identity into the event JSON:

```json
{
  "chat_id": 999,
  "channel": "group",
  "from": "Alex",
  "member_role": "driver",
  "text": "when is the next competition?",
  ...
}
```

If `from.id` is not in the member registry, the message is silently ignored (no reply). Same behavior for unknown `chat_id` in DMs.

**PRIMING per subprocess:**

- **DM subprocess:** Includes the member's profile content, their DM log path (`data/conversations/dm-<chat_id>/`), the group log path, and shared team context (VEX IQ 2026, team overview). Claude reads both logs lazily on the first turn after spawn.
- **Group subprocess:** Includes the group log path, all member names/roles summary, and shared team context. Claude reads the group log lazily on first turn. Per-turn event JSON identifies the speaker.

Both subprocess types have access to the shared KB path in the vault.

---

## 3. Conversation Logs

**New namespaced structure:**

```
data/conversations/
  dm-<chat_id>/
    YYYY-MM-DD.md     ← per-member DM log
  group-<chat_id>/
    YYYY-MM-DD.md     ← group chat log
```

Format unchanged:
```
[HH:MM] user: message text
[HH:MM] bot: response text
```

The existing `data/conversations/YYYY-MM-DD.md` (flat, unnested) becomes the admin's DM log path. The daemon migrates to writing admin DM logs under `data/conversations/dm-<admin_chat_id>/` going forward; old files remain readable by Claude via lazy load.

**Cross-log reading:** Both DM and group subprocess PRIMINGs instruct Claude to load their own channel log plus the group log on first turn after spawn. Since all context is public, this gives full shared awareness without eager injection.

---

## 4. Quota System

**Tracking:** `data/quotas/<chat_id>.json`

```json
{ "date": "2026-05-22", "count": 23 }
```

**Check logic** (runs in daemon before subprocess dispatch, DM messages only):

1. Load `data/quotas/<chat_id>.json`; create `{date: today, count: 0}` if missing
2. If `date` ≠ today → reset `count` to 0 and update `date`
3. Look up member's `daily_dm_quota` (fall back to `DEFAULT_DM_QUOTA` if not set; skip check entirely for admin)
4. If `count >= quota` → send quota-exceeded reply directly (daemon, not Claude), return without dispatching
5. Otherwise → increment `count`, save, dispatch to subprocess

**Quota-exceeded reply:**
> "You've reached your daily message limit. Resets tomorrow. You can still ask me in the group channel anytime 🙏"

**Group chat:** Never quota-checked. Quota only applies to private DMs.

---

## 5. Admin Telegram Commands

Registered via `bin/tg-set-commands.ts` using Telegram's `BotCommandScopeChat` scoped to the admin's `chat_id`. These commands are invisible to all other members.

| Command | Argument | Effect |
|---|---|---|
| `/list_members` | — | Lists all registered members with today's DM quota usage |
| `/quota` | `alex` | Shows a specific member's quota usage today |
| `/reset_quota` | `alex` | Resets a specific member's daily DM count to 0 |

General commands (visible to all members) remain whatever is currently registered — e.g. `/help`.

Command handling is done inside the existing daemon dispatch flow: if the message is from the admin chat_id and matches a command prefix, the daemon handles it directly and returns without hitting the subprocess.

---

## 6. Shared Knowledge Base

The existing KB in the vault is shared across all subprocesses. Each subprocess PRIMING includes the KB path. No structural changes needed to the KB itself — members and admin can all contribute to and query it through their respective conversations.

---

## Out of Scope

- Per-member private KB pages (can be added later as member notes in their `.md` profile)
- Token-based quota (daily message count is sufficient for now)
- Self-service member registration (admin manages files directly)
- Web dashboard or non-Telegram interfaces
