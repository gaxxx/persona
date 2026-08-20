/**
 * Version-coupled Claude Code TUI strings — centralized so a TUI redesign is a
 * one-file fix (see INTERACTIVE-NOTES.md limitation #4). These are UI strings
 * observed in Claude Code v2.1.x. If a future TUI version renames them, turn
 * detection / auth detection will silently break — update HERE and nowhere else.
 */

/** Footer text present the WHOLE time a turn is processing (incl. tool calls).
 *  Its appearance-then-absence is the primary turn-completion signal. */
export const WORKING_MARKER = "esc to interrupt";

/** Post-turn completion footer, e.g. "✻ Cooked for 2s" / "✻ Brewed for 3s" /
 *  "✻ Worked for 1s". A *change* in this line is a per-turn done-signal that
 *  catches fast turns whose WORKING_MARKER flickers past between polls.
 *  Anchored with ^ after trimming; excludes the live spinner (which carries the
 *  WORKING_MARKER) by construction. */
export const COMPLETION_FOOTER_RE = /^✻\s+\w+\s+for\s+\d/;

/** Screen substrings that mean the session needs (re-)authentication. The first
 *  two MUST stay a superset of tg-daemon's stream-json AUTH_ERROR_PATTERN
 *  (/Not logged in|Please run \/login/) so the interactive backend can surface
 *  the same signal the daemon already knows how to handle. The TUI's own login
 *  screen wording may differ across versions — extend this list if a real auth
 *  failure slips through. */
export const AUTH_SCREEN_PATTERNS: RegExp[] = [
  /Not logged in/,
  /Please run \/login/,
  /Invalid API key/,
  /Login required/,
];

/** Canonical auth-failure string the interactive backend returns as the turn
 *  result on an auth screen. Chosen to match tg-daemon's AUTH_ERROR_PATTERN so
 *  the existing dispatch()-level handling (alert user + kill + respawn) fires
 *  unchanged. */
export const AUTH_SIGNAL = "Please run /login";

/** Detect a tg-send invocation in scraped turn output. The persona sends its
 *  own Telegram replies by running `bin/tg-send.ts` / `-photo` / `-doc` as a
 *  Bash tool; in the TUI those render as `●`-bulleted command lines. Matching
 *  the path substring covers all three. */
export const TG_SEND_RE = /bin\/tg-send/;
