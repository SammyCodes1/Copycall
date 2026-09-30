/**
 * Copy-alert text (MVP feature 7 + addendum G). Pure, unit-tested.
 *  - plain text only (no parse_mode), so nothing in a title is interpreted
 *  - titles cleaned (NFKC, no invisible characters), defanged, then truncated
 *    to 120 characters: Telegram auto-links URLs, IPs, @mentions, #tags and
 *    /commands even in plain text
 *  - the only link is APP_URL/copy/<our internal trade id>: never amount,
 *    side, market or price in the URL (hard requirement 2)
 */
import { TITLE_MAX, cleanText } from "./text";

export type AlertInput = {
  appOrigin: string; // exact APP_URL origin
  tradeId: string; // trades.id (uuid)
  leaderWallet: string;
  hitRate: number | null; // 0..1, null if not ranked yet
  resolvedCalls: number;
  side: "YES" | "NO";
  title: string; // untrusted
  isCreatorTrade: boolean;
  creatorVerified: boolean;
  mock: boolean;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The copy link. Throws unless the id is a uuid, so nothing else can ride along. */
export function copyUrl(appOrigin: string, tradeId: string): string {
  if (!UUID.test(tradeId)) throw new Error("tradeId must be a uuid");
  const origin = new URL(appOrigin).origin;
  return `${origin}/copy/${tradeId}`;
}

// Dot look-alikes that NFKC leaves alone (ideographic / halfwidth / vertical full stops).
const DOT_LIKE = /[\u3002\uff61\ufe12]/g;
// Combining marks directly after ASCII: NFKC composes the real accented letters,
// so anything left is decoration that can hide a dot boundary (e.g. "evile\u0301.com").
const ASCII_COMBINING = /(?<=[\x21-\x7e])\p{M}+/gu;
const ALNUM = "[\\p{L}\\p{N}\\p{M}_-]";

/**
 * Stop Telegram from turning parts of an untrusted title into links, mentions,
 * hashtags or bot commands (audit B2-02). Input must already be cleanText()-ed
 * (NFKC, no Cf/invisible characters). Allow-list approach:
 *  - EVERY dot between two alphanumerics becomes "[.]" (domains, bare IPv4,
 *    "a.b.c"), except a plain decimal number like "3.50" or "0.1"
 *  - "://" becomes "[:]//"
 *  - "@name" gets a zero-width space after "@" (our own, added after cleaning)
 *  - "/command" and "#tag" at a word start become "[/]command" and "[#]tag"
 */
export function defang(text: string): string {
  const t = text.replace(DOT_LIKE, ".").replace(ASCII_COMBINING, "");
  return (
    t
      .replace(/:\/\//g, "[:]//")
      // Any run of dotted alphanumerics ("evil.com", "1.2.3.4", "a.b"), decimals excepted.
      .replace(new RegExp(`${ALNUM}+(?:\\.${ALNUM}+)+`, "gu"), (run) =>
        /^\d+\.\d+$/.test(run) ? run : run.replace(/\./g, "[.]"),
      )
      .replace(/@(?=[\p{L}\p{N}_])/gu, "@\u200b")
      .replace(/(^|[\s([{"'«“‘])\/(?=[\p{L}\p{N}_])/gu, "$1[/]")
      .replace(/(^|[\s([{"'«“‘])#(?=[\p{L}\p{N}_])/gu, "$1[#]")
  );
}

/** Tokens defang() inserts; truncation must not cut through one. */
const DEFANG_TOKENS = ["[.]", "[:]//", "[/]", "[#]", "@\u200b"];

/**
 * Title for a Telegram alert: clean, defang, THEN truncate to 120 (audit B2-08),
 * backing off so no defang token is split.
 */
export function alertTitle(raw: string | null | undefined): string {
  const c = cleanText(raw ?? "");
  if (!c) return "Untitled market";
  const d = defang(c);
  const cps = Array.from(d);
  if (cps.length <= TITLE_MAX) return d;
  let cut = TITLE_MAX - 1;
  for (const tok of DEFANG_TOKENS) {
    const tl = Array.from(tok).length;
    // If a token starts within the last tl-1 kept code points and runs past the cut, cut before it.
    for (let i = Math.max(0, cut - tl + 1); i < cut; i++) {
      if (cps.slice(i, i + tl).join("") === tok && i + tl > cut) {
        cut = i;
        break;
      }
    }
  }
  return `${cps.slice(0, cut).join("")}…`;
}

export function shortWallet(w: string): string {
  return `${w.slice(0, 4)}…${w.slice(-4)}`;
}

export function formatAlert(a: AlertInput): string {
  const stats =
    a.hitRate === null ? "not ranked yet" : `hit rate ${Math.round(a.hitRate * 100)}%, ${a.resolvedCalls} calls`;
  const lines = [
    `${a.mock ? "[MOCK] " : ""}${shortWallet(a.leaderWallet)} (${stats}) bought ${a.side} on '${alertTitle(a.title)}'.`,
  ];
  if (a.isCreatorTrade) {
    lines.push(
      a.creatorVerified
        ? "◆ Creator trade: this trader created the market."
        : "◆ Creator trade (unverified): this trader appears to have created the market.",
    );
  }
  lines.push(`Copy: ${copyUrl(a.appOrigin, a.tradeId)}`);
  return lines.join("\n");
}
