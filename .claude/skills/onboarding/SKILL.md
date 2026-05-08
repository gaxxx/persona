---
name: onboarding
description: Conversational profile setup over Telegram. Trigger when `<vault>/persona/USER.md` or `IDENTITY.md` has "not set"/empty fields, or the user explicitly asks to (re)do onboarding ("做一下 onboarding", "redo onboarding", "补一下个人信息", "let's set up", "重新设置 identity"). Do NOT trigger for casual greetings if all required fields are already filled.
---

# Onboarding

Fill in the persona's two profile files via natural Telegram conversation:

- `<vault>/persona/USER.md` — about the human
- `<vault>/persona/IDENTITY.md` — about you (the assistant)

This is the bridge between `/setup` (CLI bootstrap, run once on a fresh checkout) and a fully-personalized assistant. `/setup` only collects what's needed to make Telegram work; everything else lives here.

## When to trigger

- First Telegram message after a fresh install (USER.md still has "not set" fields)
- USER.md grew a new field after a repo update — fill the gaps
- User explicitly says "做一下 onboarding" / "redo onboarding" / "补充一下个人信息" / "重新设置 identity"
- You notice during a conversation that a required field is missing AND the user's current request would benefit from knowing it (then ask just that one)

Do NOT trigger when all required fields are filled and the user just sent a normal message.

## How to run

### 1. Read both files first

```
<vault>/persona/USER.md
<vault>/persona/IDENTITY.md
```

Identify which fields are "not set" or empty. If everything is filled → tell the user "都填好了，需要改啥告诉我" and exit; don't ask redundant questions.

### 2. Read language(s) from USER.md

`USER.md` Language field is a comma-separated list set by `/setup` step 0 — the **first entry is primary**, the rest are also-spoken. Examples: `中文`, `English`, `中文, English`.

For onboarding prompts: use the primary unless the user's incoming message is in another language from the list (then match that message's language). Per the rule in CLAUDE.md, autonomous outputs (cron etc.) use primary; replies match the user's message language.

**Fallback** (only if Language is still "not set" — legacy users who skipped that step): infer from the user's most recent message. If the message is too short to tell (single emoji, "ok", "/start", "👍"), ask once: `想用中文还是 English 聊都行 / Pick a language: zh or en (or both)?`. Write the answer back to USER.md as a list (primary first) so we never have to ask again.

### 3. Ask conversationally — NOT a wall of questions

Bad: "Please tell me your name, pronouns, birthday, timezone, location, language, family, work."

Good: ask 1-2 related fields at a time, react to the answer, then move to the next batch. Like texting a new friend who's getting to know you.

Suggested groupings (adjust order based on what feels natural):

1. **Greeting + name**: 你叫什么？我该怎么称呼你？(name + what to call them)
2. **When/where**: 你那边现在几点？平时主要用什么语言？(timezone via clock-check + language) — see Timezone trick below
3. **Identity (yours)**: 给我起个名字呗 + 你希望我是啥风格的？(IDENTITY name + vibe)
4. **About them**: 简单介绍下自己呗 — 工作、家庭、在意的事 (free-form context, write to USER.md Notes / Context section)
5. **Birthday / location** (optional, ask only if user seems comfortable)
6. **Anything to remember from day 1**: 有啥要我现在就记住的？(seed MEMORY.md if they say yes)

### 4. After each answer, update the file immediately

Use the Edit tool on `<vault>/persona/USER.md` or `IDENTITY.md`. Preserve any fields they didn't answer (leave as "not set" — don't fabricate).

For free-form info (family details, work context, hobbies), append to the `## Context` section of USER.md as a short paragraph or bullets — don't try to cram everything into the structured fields.

### 5. End cleanly

After core fields are filled (name + timezone + language + IDENTITY name & vibe), tell them:

> 差不多了！剩下的（生日、location 啥的）以后聊到了我自己补上。要看 / 改的话直接说。

Don't drag onboarding out. Skipped fields are fine — you'll learn them naturally over time and update USER.md as you go (per CLAUDE.md memory table).

## Timezone trick

Don't ask "你在哪个时区" — most people don't know their IANA tz string. Instead:

1. Default to the system tz (run `bun run bin/lib/user-tz.ts` or just `date` to get current local time on the daemon machine).
2. Ask "你那边现在几点？" naturally.
3. Compare their answer to the daemon's current hour:
   - Match (±1h tolerance for rough answers like "晚上八点多") → keep system tz, write it to USER.md.
   - Mismatch → compute the offset from UTC implied by their hour, pick a sensible IANA tz (e.g. UTC+8 → `Asia/Shanghai`, UTC-5 → `America/New_York`, UTC-8 → `America/Los_Angeles`). If ambiguous (multiple common zones share an offset), pick the most likely based on their language + any location hints, and confirm: "那你应该在 Asia/Shanghai 是吧？".
4. Save the IANA tz string to USER.md — never just an offset like "UTC+8" (DST will break it).

## Required vs optional

**Required** (block exit until filled):
- USER.md: Name, What to call them, Timezone, Language
- IDENTITY.md: Name, Vibe

**Optional** (ask if it flows naturally; otherwise skip):
- USER.md: Pronouns, Birthday, Location, Email, Notes/Context
- IDENTITY.md: Creature, Emoji

`Telegram chat_id` in USER.md auto-fills from the incoming event — no need to ask.

## Style

- 1-3 sentences per question. No bullet lists of questions.
- React to answers ("好名字 ✨" / "got it") before moving on — don't interview.
- If the user pushes back ("先别问这个"), skip and move on. Optional fields are optional.
- Match `IDENTITY.md` vibe once it's set — but during onboarding itself, default warm + brief.

## Output

Every reply MUST go through `bun run bin/tg-send.ts <chat_id>` (per CLAUDE.md). Log the turn to `data/conversations/YYYY-MM-DD.md` like any other Telegram exchange.
