#!/usr/bin/env node
/**
 * Proves no secrets or secret names reach the browser: scans every file under
 * .next/static (the client bundle) for secret env names, Panta key prefixes,
 * and the actual values of any secret env vars set in this shell.
 * Run after `npm run build`:  npm run check:bundle
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(process.cwd(), ".next", "static");
const NAMES = [
  "PANTA_API_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SERVICE_ROLE",
  "service_role",
  "SESSION_SECRET",
  "CRON_SECRET",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_WEBHOOK_SECRET",
  "SOLANA_RPC_URL",
  "OPS_ALERT_WEBHOOK_URL",
  "hooks.slack.com",
  "pk_test_",
  "pk_live_",
  "X-Api-Key",
  "live-api.panta.market",
];
const VALUE_VARS = ["PANTA_API_KEY", "SUPABASE_SERVICE_ROLE_KEY", "SESSION_SECRET", "CRON_SECRET", "TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "SOLANA_RPC_URL", "OPS_ALERT_WEBHOOK_URL"];
const needles = [
  ...NAMES.map((n) => ({ label: n, value: n })),
  ...VALUE_VARS.filter((v) => (process.env[v] ?? "").length >= 8).map((v) => ({ label: `value of ${v}`, value: process.env[v] })),
];

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

let files;
try {
  files = walk(ROOT);
} catch {
  console.error("No .next/static found. Run `npm run build` first.");
  process.exit(2);
}

const hits = [];
for (const file of files) {
  const text = readFileSync(file, "latin1");
  for (const n of needles) if (text.includes(n.value)) hits.push(`${n.label} in ${file.replace(process.cwd() + "/", "")}`);
}
console.log(`Scanned ${files.length} client files for ${needles.length} patterns.`);
if (hits.length) {
  console.error("FOUND possible secret leaks:\n" + hits.map((h) => "  - " + h).join("\n"));
  process.exit(1);
}
console.log("OK: no secret names, key prefixes or secret values found in .next/static");
