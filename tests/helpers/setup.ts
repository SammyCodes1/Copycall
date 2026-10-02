import { randomBytes } from "node:crypto";

// Test-only env. Secrets are random per run; nothing is hardcoded.
process.env.SESSION_SECRET = randomBytes(32).toString("base64url");
process.env.APP_URL = "http://localhost:3000";
process.env.MOCK_PANTA = "true";
delete process.env.VERCEL_ENV;
// H-07: tests are hermetic. Credentials for live services that happen to be in the shell's
// environment must never reach a test (a real TELEGRAM_BOT_TOKEN made two tests call
// api.telegram.org). Tests that need one set a dummy value themselves.
for (const k of [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_WEBHOOK_SECRET",
  "PANTA_API_KEY",
  "PANTA_BASE_URL",
  "SOLANA_RPC_URL",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "CRON_SECRET",
])
  delete process.env[k];
