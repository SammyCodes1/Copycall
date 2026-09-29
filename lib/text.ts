/**
 * Untrusted-text helpers (addendum G). Market titles and every other Panta
 * string are untrusted: they are rendered as React text (never HTML) and sent
 * to Telegram as plain text. Pure functions, shared by server and tests.
 */

export const TITLE_MAX = 120;

// C0/C1 control characters (titles are single-line, so newlines go too) and
// Unicode bidi marks/overrides/isolates, which can visually reorder text in a
// chat message or on the page.
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** Strip control/bidi characters and collapse whitespace. */
export function cleanText(t: string): string {
  return t.replace(UNSAFE_CHARS, " ").replace(/\s+/g, " ").trim();
}

/** Clean and truncate a market title to at most 120 characters (with an ellipsis). */
export function safeTitle(t: string | null | undefined): string {
  const c = cleanText(t ?? "");
  if (!c) return "Untitled market";
  return c.length > TITLE_MAX ? `${c.slice(0, TITLE_MAX - 1)}…` : c;
}
