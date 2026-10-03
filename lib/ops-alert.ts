import "server-only";
/**
 * Operator alert webhook (optional, OPS_ALERT_WEBHOOK_URL, a Sensitive env var).
 *
 * Every operator alert is still logged exactly as before (`[ALERT] <message>` on stderr). If the
 * webhook is configured, a SANITIZED line is also posted to Discord or Slack: never the free-text
 * message (it can carry Panta's raw text, amounts, wallet prefixes), only an allowlisted event,
 * an allowlisted code, the kind and an 8-hex-char order id, built from fixed parts.
 *
 * Delivery: one attempt, 5 s timeout, no redirects, failures are a console.warn without the URL
 * or the response. It never throws or blocks the caller; route handlers await flushOpsAlerts()
 * (bounded by the same 5 s) before returning so a serverless instance doesn't drop the post.
 * Rate limit (per process; instances don't share memory): one post per alert key (event + code
 * + order id) per hour, and at most GLOBAL_MAX posts per 10 minutes.
 */

export type OpsEvent =
  | "ALERT"
  | "FEE_MODEL"
  | "REPORT_REFUSED"
  | "REVIEW_FLAGGED"
  | "REVIEW_WRITE_FAILED"
  | "REVIVED_FAILED_ORDER"
  | "TOPLEVEL_CHECK"
  | "SYSTEM_CHECK_ERROR"
  | "TOKEN_UNKNOWN"
  | "WALLET_MISSING"
  | "ATA_DRIFT"
  | "SWEEP_GAVE_UP"
  | "SWEEP_STOPPED"
  | "SWEEP_TIMEOUT"
  | "SWEEP_UNSETTLED"
  | "ABANDON_ROW_ERRORS"
  | "ABANDON_LIST_FAILED";

/** Structured, webhook-safe facts about an alert. Only allowlisted values ever leave. */
export type AlertTag = { event: OpsEvent; code?: string; kind?: string; id?: string };

const EVENTS: ReadonlySet<string> = new Set<OpsEvent>([
  "ALERT",
  "FEE_MODEL",
  "REPORT_REFUSED",
  "REVIEW_FLAGGED",
  "REVIEW_WRITE_FAILED",
  "REVIVED_FAILED_ORDER",
  "TOPLEVEL_CHECK",
  "SYSTEM_CHECK_ERROR",
  "TOKEN_UNKNOWN",
  "WALLET_MISSING",
  "ATA_DRIFT",
  "SWEEP_GAVE_UP",
  "SWEEP_STOPPED",
  "SWEEP_TIMEOUT",
  "SWEEP_UNSETTLED",
  "ABANDON_ROW_ERRORS",
  "ABANDON_LIST_FAILED",
]);
/** Codes our own checks emit (TxRejected / Panta report codes / fee-model codes). */
const CODES: ReadonlySet<string> = new Set([
  "USDC_AUTHORITY",
  "UNEXPECTED_CPI",
  "UNKNOWN_PROGRAM",
  "WALLET_OWNER",
  "WALLET_MISSING",
  "SYSTEM_CPI",
  "OVER_LIMIT",
  "PAYOUT_TOO_LOW",
  "TOKEN_UNKNOWN",
  "INNER_UNAVAILABLE",
  "FEE_MODEL_MISMATCH",
  "FEE_MODEL_UNKNOWN",
  "TX_FEE_MISMATCH",
  "TX_MISMATCH",
]);
const KINDS: ReadonlySet<string> = new Set(["copy", "claim"]);

export const OPS_ALERT_TIMEOUT_MS = 5_000;
export const PER_KEY_INTERVAL_MS = 60 * 60_000;
export const GLOBAL_WINDOW_MS = 10 * 60_000;
export const GLOBAL_MAX = 20;
const MAX_LEN = 160;

type Hook = { url: string; kind: "discord" | "slack" };

/**
 * Only https, no userinfo, default port, no query/fragment, host EXACTLY discord.com (path
 * /api/webhooks/...) or hooks.slack.com (path /services/...). Anything else: null (disabled).
 */
export function parseOpsWebhook(raw: string | undefined): Hook | null {
  if (!raw || raw.trim() === "") return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username !== "" || u.password !== "" || u.port !== "") return null;
  if (u.search !== "" || u.hash !== "") return null;
  if (u.hostname === "discord.com" && /^\/api\/webhooks\/[0-9]{1,30}\/[A-Za-z0-9_-]{1,200}$/.test(u.pathname))
    return { url: u.href, kind: "discord" };
  if (u.hostname === "hooks.slack.com" && /^\/services\/[A-Za-z0-9/_-]{1,200}$/.test(u.pathname))
    return { url: u.href, kind: "slack" };
  return null;
}

let warnedInvalid = false;
function hook(): Hook | null {
  const raw = process.env.OPS_ALERT_WEBHOOK_URL;
  if (!raw || raw.trim() === "") return null;
  const h = parseOpsWebhook(raw);
  if (!h && !warnedInvalid) {
    warnedInvalid = true;
    console.warn("[ops-alert] OPS_ALERT_WEBHOOK_URL is not an allowed webhook URL; the operator alert webhook is disabled");
  }
  return h;
}

/** The only text that is ever posted: fixed parts, allowlisted values, printable ASCII, capped. */
export function sanitizeAlert(tag: AlertTag | undefined): string {
  const parts = ["CopyCall alert", tag && EVENTS.has(tag.event) ? tag.event : "ALERT"];
  if (tag?.code && CODES.has(tag.code)) parts.push(tag.code);
  if (tag?.kind && KINDS.has(tag.kind)) parts.push(tag.kind);
  const id = typeof tag?.id === "string" ? tag.id.slice(0, 8).toLowerCase() : "";
  if (/^[0-9a-f]{8}$/.test(id)) parts.push(`order ${id}`);
  return parts.join(" ").replace(/[^A-Za-z0-9 _]/g, "").slice(0, MAX_LEN);
}

const lastByKey = new Map<string, number>();
let sentAt: number[] = [];
const pending = new Set<Promise<void>>();

/** Tests only. */
export function resetOpsAlerts(): void {
  lastByKey.clear();
  sentAt = [];
  pending.clear();
  warnedInvalid = false;
}

function allow(key: string, now: number): boolean {
  const last = lastByKey.get(key);
  if (last !== undefined && now - last < PER_KEY_INTERVAL_MS) return false;
  sentAt = sentAt.filter((t) => now - t < GLOBAL_WINDOW_MS);
  if (sentAt.length >= GLOBAL_MAX) return false;
  if (lastByKey.size > 10_000) lastByKey.clear();
  lastByKey.set(key, now);
  sentAt.push(now);
  return true;
}

async function post(h: Hook, text: string): Promise<void> {
  const body = h.kind === "discord" ? { content: text, allowed_mentions: { parse: [] } } : { text };
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      ctrl.abort();
      resolve("timeout");
    }, OPS_ALERT_TIMEOUT_MS);
  });
  try {
    const sent = Promise.resolve()
      .then(() =>
        fetch(h.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          redirect: "error",
          signal: ctrl.signal,
        }),
      )
      .then(
      (r) => (r.ok ? "ok" : `http ${r.status}`),
      () => "network error",
    );
    // A fetch that ignores the abort still can't hold us past the timeout.
    const r = await Promise.race([sent, timeout]);
    if (r !== "ok") console.warn(`[ops-alert] webhook post failed (${r})`);
  } catch {
    console.warn("[ops-alert] webhook post failed");
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The operator alert: logs `[ALERT] <message>` as before, and (if configured and not rate
 * limited) queues the sanitized webhook post. Never throws.
 */
export function opsAlert(message: string, tag?: AlertTag): void {
  console.error(`[ALERT] ${message}`);
  try {
    const h = hook();
    if (!h) return;
    const text = sanitizeAlert(tag);
    const key = `${tag?.event ?? "ALERT"}:${tag?.code ?? ""}:${typeof tag?.id === "string" ? tag.id.slice(0, 8) : ""}`;
    if (!allow(key, Date.now())) return;
    const p = post(h, text).catch(() => {});
    pending.add(p);
    void p.finally(() => pending.delete(p));
  } catch {
    // never let alerting change the flow
  }
}

/** Await queued posts (each bounded by OPS_ALERT_TIMEOUT_MS). Never throws. */
export async function flushOpsAlerts(): Promise<void> {
  try {
    await Promise.allSettled([...pending]);
  } catch {
    // ignore
  }
}
