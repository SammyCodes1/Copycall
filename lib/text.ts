/**
 * Untrusted-text helpers (addendum G). Market titles and every other Panta
 * string are untrusted: they are rendered as React text (never HTML) and sent
 * to Telegram as plain text. Pure functions, shared by server and tests.
 */

export const TITLE_MAX = 120;

// C0/C1 controls (titles are single-line, so newlines go too) become spaces.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
// Every format / invisible character (Unicode Cf: bidi marks and overrides,
// ZWSP/ZWNJ/ZWJ, word joiner, invisible operators, BOM, soft hyphen, ALM...)
// is removed outright (audit B2-09), plus the variation selectors.
const INVISIBLE = /[\p{Cf}\u180b-\u180f\ufe00-\ufe0f\u{e0100}-\u{e01ef}]/gu;

/** NFKC-normalise, strip control/format/invisible characters, collapse whitespace. */
export function cleanText(t: string): string {
  return t.normalize("NFKC").replace(CONTROL, " ").replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
}

/** Truncate to `max` code points with an ellipsis, never splitting a surrogate pair. */
export function truncate(t: string, max = TITLE_MAX): string {
  const cps = Array.from(t);
  return cps.length > max ? `${cps.slice(0, max - 1).join("")}…` : t;
}

/** Clean and truncate a market title to at most 120 characters (with an ellipsis). */
export function safeTitle(t: string | null | undefined): string {
  const c = cleanText(t ?? "");
  if (!c) return "Untitled market";
  return truncate(c);
}
