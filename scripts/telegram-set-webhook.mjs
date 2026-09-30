#!/usr/bin/env node
/**
 * Registers the Telegram webhook with a secret token (hard requirement 6).
 *
 *   node --env-file=.env.local scripts/telegram-set-webhook.mjs          # set
 *   node --env-file=.env.local scripts/telegram-set-webhook.mjs --info   # show current
 *
 * Reads TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and APP_URL from the
 * environment. Nothing is hardcoded and the token is never printed.
 * Telegram then sends X-Telegram-Bot-Api-Secret-Token on every update and
 * /api/telegram/webhook rejects requests without it (401).
 */
const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_WEBHOOK_SECRET: secret, APP_URL: appUrl } = process.env;

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

if (!token) fail("TELEGRAM_BOT_TOKEN is not set");
const api = (method) => `https://api.telegram.org/bot${token}/${method}`;

async function call(method, body) {
  const res = await fetch(api(method), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) fail(`${method} failed: ${data.description ?? res.status}`);
  return data.result;
}

if (process.argv.includes("--info")) {
  const info = await call("getWebhookInfo");
  console.log(
    JSON.stringify(
      { url: info.url, pending_update_count: info.pending_update_count, last_error_message: info.last_error_message },
      null,
      2,
    ),
  );
  process.exit(0);
}

// Telegram: secret_token is 1-256 chars of A-Z a-z 0-9 _ -. We require >= 32 for strength.
if (!secret || !/^[A-Za-z0-9_-]{32,256}$/.test(secret)) {
  fail(
    "TELEGRAM_WEBHOOK_SECRET must be 32-256 chars of A-Z a-z 0-9 _ - (e.g. node -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\")",
  );
}
if (!appUrl) fail("APP_URL is not set");
const origin = new URL(appUrl);
if (origin.protocol !== "https:") fail("APP_URL must be https (Telegram only calls https webhooks)");

const url = `${origin.origin}/api/telegram/webhook`;
await call("setWebhook", {
  url,
  secret_token: secret,
  allowed_updates: ["message", "callback_query"],
  drop_pending_updates: true,
});
console.log(`Webhook set to ${url} (secret token configured, updates: message, callback_query).`);
