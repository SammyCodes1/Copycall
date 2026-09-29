/**
 * Copy-alert text (MVP feature 7 + addendum G). Pure, unit-tested.
 *  - plain text only (no parse_mode), so nothing in a title is interpreted
 *  - titles cleaned and truncated to 120 characters
 *  - URL-like fragments and @mentions in the title are defanged, because
 *    Telegram auto-links them even in plain text
 *  - the only link is APP_URL/copy/<our internal trade id>: never amount,
 *    side, market or price in the URL (hard requirement 2)
 */
import { safeTitle } from "./text";

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

/** Stop Telegram from turning parts of an untrusted title into links or mentions. */
export function defang(text: string): string {
  return text
    .replace(/:\/\//g, "[:]//")
    .replace(/([\p{L}\p{N}-])\.(?=\p{L}{2,})/gu, "$1[.]") // "evil.com" -> "evil[.]com"; "3.50" untouched
    .replace(/@(?=[\p{L}\p{N}_]{3,})/gu, "@\u200b"); // break @mentions
}

export function shortWallet(w: string): string {
  return `${w.slice(0, 4)}…${w.slice(-4)}`;
}

export function formatAlert(a: AlertInput): string {
  const stats = a.hitRate === null ? "not ranked yet" : `hit rate ${Math.round(a.hitRate * 100)}%, ${a.resolvedCalls} calls`;
  const lines = [
    `${a.mock ? "[MOCK] " : ""}${shortWallet(a.leaderWallet)} (${stats}) bought ${a.side} on '${defang(safeTitle(a.title))}'.`,
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
