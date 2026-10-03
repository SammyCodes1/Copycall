/**
 * Operator alert webhook (OPS_ALERT_WEBHOOK_URL): host allowlist, sanitized payloads, a 5 s
 * single attempt that never throws or blocks, per-key + global rate limits, URL never logged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  GLOBAL_MAX,
  OPS_ALERT_TIMEOUT_MS,
  flushOpsAlerts,
  opsAlert,
  parseOpsWebhook,
  resetOpsAlerts,
  sanitizeAlert,
  type AlertTag,
} from "@/lib/ops-alert";
import { reportOnce } from "@/lib/report-retry";
import { PantaError } from "@/lib/panta-error";

// Built at runtime so no webhook-shaped literal sits in the repo (secret scanners).
const DISCORD_HOST = ["discord", "com"].join(".");
const SLACK_HOST = ["hooks", "slack", "com"].join(".");
const TOKEN = "tok3n_" + "Zx9";
const DISCORD = `https://${DISCORD_HOST}/api/webhooks/1234567890/${TOKEN}`;
const SLACK = `https://${SLACK_HOST}/services/T000/B000/${TOKEN}`;

type Call = { url: string; init: RequestInit };
let calls: Call[];
let logged: string[];
const body = (i = 0) => JSON.parse(String(calls[i].init.body));

beforeEach(() => {
  resetOpsAlerts();
  calls = [];
  logged = [];
  for (const m of ["error", "warn", "info", "log"] as const)
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(" ")));
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response("ok body with " + TOKEN, { status: 200 });
  });
});
afterEach(() => {
  delete process.env.OPS_ALERT_WEBHOOK_URL;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const neverLoggedUrl = () => {
  for (const l of logged) {
    expect(l).not.toContain(TOKEN);
    expect(l).not.toContain(DISCORD_HOST);
    expect(l).not.toContain(SLACK_HOST);
  }
};

describe("host allowlist", () => {
  it("accepts only https discord.com /api/webhooks/... and hooks.slack.com /services/...", () => {
    expect(parseOpsWebhook(DISCORD)).toEqual({ url: DISCORD, kind: "discord" });
    expect(parseOpsWebhook(SLACK)).toEqual({ url: SLACK, kind: "slack" });
    expect(parseOpsWebhook(`  ${DISCORD}  `)?.kind).toBe("discord");
    expect(parseOpsWebhook(DISCORD.replace(DISCORD_HOST, DISCORD_HOST.toUpperCase()))?.kind).toBe("discord"); // hosts are case-insensitive
  });

  it.each([
    ["empty", ""],
    ["not a URL", "discord webhook"],
    ["http", DISCORD.replace("https:", "http:")],
    ["other host", DISCORD.replace(DISCORD_HOST, "evil.example")],
    ["subdomain", DISCORD.replace(DISCORD_HOST, `x.${DISCORD_HOST}`)],
    ["suffix trick", DISCORD.replace(DISCORD_HOST, `${DISCORD_HOST}.evil.example`)],
    ["discordapp.com (legacy, not needed)", DISCORD.replace(DISCORD_HOST, "discordapp.com")],
    ["slack.com (not hooks.)", SLACK.replace(SLACK_HOST, "slack.com")],
    ["userinfo", DISCORD.replace("https://", "https://u:p@")],
    ["user only", DISCORD.replace("https://", "https://u@")],
    ["non-default port", DISCORD.replace(DISCORD_HOST, `${DISCORD_HOST}:8443`)],
    ["explicit 443 is normalised away (still accepted)", null],
    ["query", `${DISCORD}?wait=true`],
    ["fragment", `${DISCORD}#x`],
    ["wrong discord path", `https://${DISCORD_HOST}/oauth2/authorize`],
    ["wrong slack path", `https://${SLACK_HOST}/workflows/x`],
    ["IP", "https://162.159.135.232/api/webhooks/1/x"],
  ])("rejects %s", (_name, raw) => {
    if (raw === null) {
      expect(parseOpsWebhook(DISCORD.replace(DISCORD_HOST, `${DISCORD_HOST}:443`))?.kind).toBe("discord");
      return;
    }
    expect(parseOpsWebhook(raw)).toBeNull();
  });

  it("an invalid value disables it with ONE generic warning that never contains the value", async () => {
    process.env.OPS_ALERT_WEBHOOK_URL = DISCORD.replace("https:", "http:");
    opsAlert("a", { event: "SWEEP_TIMEOUT" });
    opsAlert("b", { event: "SWEEP_GAVE_UP" });
    await flushOpsAlerts();
    expect(calls.length).toBe(0);
    const warns = logged.filter((l) => l.includes("[ops-alert]"));
    expect(warns).toEqual(["[ops-alert] OPS_ALERT_WEBHOOK_URL is not an allowed webhook URL; the operator alert webhook is disabled"]);
    neverLoggedUrl();
  });

  it("unset: logs as before, posts nothing, no warning", async () => {
    opsAlert("hello", { event: "ALERT" });
    await flushOpsAlerts();
    expect(calls.length).toBe(0);
    expect(logged).toEqual(["[ALERT] hello"]);
  });
});

describe("payload and redaction", () => {
  it("Discord: {content, allowed_mentions: {parse: []}}; Slack: {text}; POST, JSON, redirect: 'error', with an abort signal", async () => {
    process.env.OPS_ALERT_WEBHOOK_URL = DISCORD;
    const id = randomUUID();
    opsAlert("free text", { event: "REVIEW_FLAGGED", code: "USDC_AUTHORITY", kind: "copy", id });
    await flushOpsAlerts();
    expect(calls[0].url).toBe(DISCORD);
    expect(calls[0].init).toMatchObject({ method: "POST", redirect: "error", headers: { "Content-Type": "application/json" } });
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
    expect(body()).toEqual({ content: `CopyCall alert REVIEW_FLAGGED USDC_AUTHORITY copy order ${id.slice(0, 8)}`, allowed_mentions: { parse: [] } });
    resetOpsAlerts();
    calls = [];
    process.env.OPS_ALERT_WEBHOOK_URL = SLACK;
    opsAlert("free text", { event: "SWEEP_GAVE_UP", kind: "claim", id });
    await flushOpsAlerts();
    expect(body()).toEqual({ text: `CopyCall alert SWEEP_GAVE_UP claim order ${id.slice(0, 8)}` });
  });

  it("the free-text message never leaves: keys, RPC URLs with api-key, Panta raw text, newlines, ANSI, mentions", async () => {
    process.env.OPS_ALERT_WEBHOOK_URL = DISCORD;
    const nasty =
      ["pk", "live", "abcdef0123456789"].join("_") + // built at runtime (secret scanners)
      " X-Api-Key: sk_secret https://mainnet.helius-rpc.com/?api-key=deadbeef-1234 " +
      'Panta said: {"error":{"message":"internal <@everyone> @here"}}\n\r\u001b[31mred\u001b[0m\u0000\u2028 <!channel>';
    opsAlert(nasty, { event: "REPORT_REFUSED", code: "TX_MISMATCH", kind: "copy", id: "0123abcd-ffff" });
    await flushOpsAlerts();
    const raw = String(calls[0].init.body);
    for (const bad of ["pk_live", "sk_secret", "api-key", "helius", "deadbeef", "Panta said", "everyone", "@", "<", "\\n", "\\r", "\\u001b", "\\u0000", "red", "channel"])
      expect(raw).not.toContain(bad);
    expect(body().content).toBe("CopyCall alert REPORT_REFUSED TX_MISMATCH copy order 0123abcd");
    // The log keeps the full message exactly as before.
    expect(logged).toContain(`[ALERT] ${nasty}`);
  });

  it("tag values outside the allowlists are dropped, the result is printable ASCII and capped", () => {
    const evil = "USDC_AUTHORITY\n@everyone https://x/?api-key=1";
    const t = { event: "NOPE\u001b[0m", code: evil, kind: "copy; rm -rf", id: "zz<@1>zzzz" } as unknown as AlertTag;
    expect(sanitizeAlert(t)).toBe("CopyCall alert ALERT");
    expect(sanitizeAlert({ event: "FEE_MODEL", code: "pk_live_x" })).toBe("CopyCall alert FEE_MODEL");
    expect(sanitizeAlert({ event: "FEE_MODEL", code: "FEE_MODEL_MISMATCH" })).toBe("CopyCall alert FEE_MODEL FEE_MODEL_MISMATCH");
    expect(sanitizeAlert(undefined)).toBe("CopyCall alert ALERT");
    for (const s of [sanitizeAlert(t), sanitizeAlert({ event: "REVIEW_FLAGGED", code: "OVER_LIMIT", kind: "claim", id: randomUUID() })]) {
      expect(s).toMatch(/^[A-Za-z0-9 _]{1,160}$/);
    }
  });

  it("a real alert site (report-retry, Panta's raw error text) posts only the code and the short order id", async () => {
    process.env.OPS_ALERT_WEBHOOK_URL = SLACK;
    const orderId = randomUUID();
    await reportOnce(
      {
        copy: { markReported: async () => {}, recordReportFailure: async () => {}, claimReportRetries: async () => [] },
        panta: { reportTrade: async () => Promise.reject(new PantaError(422, "TX_MISMATCH", "raw Panta body pk_test_123 \n<!here>")) },
      },
      { kind: "copy", orderId, signature: "5".repeat(88), wallet: "W", marketId: "m", quoteId: null, attempts: 1 },
    );
    await flushOpsAlerts();
    expect(body()).toEqual({ text: `CopyCall alert REPORT_REFUSED TX_MISMATCH copy order ${orderId.slice(0, 8)}` });
  });
});

describe("delivery: 5 s, one attempt, never throws or blocks", () => {
  it("a hanging fetch is aborted and flush resolves at ~5 s (fake timers), with a URL-free warning", async () => {
    vi.useFakeTimers();
    process.env.OPS_ALERT_WEBHOOK_URL = DISCORD;
    let signal: AbortSignal | undefined;
    let attempts = 0;
    vi.stubGlobal("fetch", (_u: string, init: RequestInit) => {
      attempts++;
      signal = init.signal ?? undefined;
      return new Promise(() => {}); // hangs forever, even ignoring the abort
    });
    expect(() => opsAlert("m", { event: "SWEEP_TIMEOUT" })).not.toThrow();
    let done = false;
    const f = flushOpsAlerts().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(OPS_ALERT_TIMEOUT_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await f;
    expect(done).toBe(true);
    expect(signal?.aborted).toBe(true);
    expect(attempts).toBe(1); // no retry
    expect(logged).toContain("[ops-alert] webhook post failed (timeout)");
    neverLoggedUrl();
  });

  it("network errors, non-2xx and a throwing fetch never throw, are not retried, and log no URL or body", async () => {
    process.env.OPS_ALERT_WEBHOOK_URL = DISCORD;
    let n = 0;
    const impls = [
      async () => Promise.reject(new Error(`connect ECONNREFUSED ${DISCORD}`)),
      async () => new Response(`bad ${TOKEN} secret body`, { status: 500 }),
      () => {
        throw new Error(DISCORD);
      },
    ];
    for (const impl of impls) {
      vi.stubGlobal("fetch", (...a: unknown[]) => (n++, (impl as (...x: unknown[]) => unknown)(...a)));
      expect(() => opsAlert("m", { event: "ALERT", id: randomUUID() })).not.toThrow();
      await expect(flushOpsAlerts()).resolves.toBeUndefined();
    }
    expect(n).toBe(3);
    expect(logged.filter((l) => l.startsWith("[ops-alert]"))).toEqual([
      "[ops-alert] webhook post failed (network error)",
      "[ops-alert] webhook post failed (http 500)",
      "[ops-alert] webhook post failed (network error)",
    ]);
    expect(logged.join("\n")).not.toContain("secret body");
    neverLoggedUrl();
  });

  it("opsAlert returns immediately (doesn't wait for the post)", async () => {
    process.env.OPS_ALERT_WEBHOOK_URL = DISCORD;
    let release!: () => void;
    vi.stubGlobal("fetch", () => new Promise<Response>((r) => (release = () => r(new Response(null, { status: 204 })))));
    const t0 = Date.now();
    opsAlert("m", { event: "ALERT" });
    expect(Date.now() - t0).toBeLessThan(50);
    await new Promise((r) => setTimeout(r, 0)); // the post starts on a later tick
    release();
    await flushOpsAlerts();
    expect(logged.filter((l) => l.startsWith("[ops-alert]"))).toEqual([]);
  });
});

describe("rate limit (per process)", () => {
  it("one post per key (event + code + order) per hour; a different key still goes", async () => {
    vi.useFakeTimers();
    process.env.OPS_ALERT_WEBHOOK_URL = DISCORD;
    const id = randomUUID();
    const tag: AlertTag = { event: "REVIEW_FLAGGED", code: "OVER_LIMIT", kind: "copy", id };
    opsAlert("1", tag);
    opsAlert("2", tag);
    opsAlert("3", { ...tag, code: "USDC_AUTHORITY" });
    opsAlert("4", { ...tag, id: randomUUID() });
    await flushOpsAlerts();
    expect(calls.length).toBe(3);
    await vi.advanceTimersByTimeAsync(59 * 60_000);
    opsAlert("5", tag);
    await flushOpsAlerts();
    expect(calls.length).toBe(3);
    await vi.advanceTimersByTimeAsync(61_000);
    opsAlert("6", tag);
    await flushOpsAlerts();
    expect(calls.length).toBe(4);
    // Every alert is still logged, rate limited or not.
    expect(logged.filter((l) => l.startsWith("[ALERT]")).length).toBe(6);
  });

  it(`global cap: at most ${GLOBAL_MAX} posts per 10 minutes`, async () => {
    vi.useFakeTimers();
    process.env.OPS_ALERT_WEBHOOK_URL = SLACK;
    for (let i = 0; i < GLOBAL_MAX + 15; i++) opsAlert(`m${i}`, { event: "SWEEP_GAVE_UP", kind: "copy", id: randomUUID() });
    await flushOpsAlerts();
    expect(calls.length).toBe(GLOBAL_MAX);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    opsAlert("later", { event: "SWEEP_GAVE_UP", kind: "copy", id: randomUUID() });
    await flushOpsAlerts();
    expect(calls.length).toBe(GLOBAL_MAX + 1);
  });
});
