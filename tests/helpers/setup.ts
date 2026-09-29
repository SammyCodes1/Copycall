import { randomBytes } from "node:crypto";

// Test-only env. Secrets are random per run; nothing is hardcoded.
process.env.SESSION_SECRET = randomBytes(32).toString("base64url");
process.env.APP_URL = "http://localhost:3000";
process.env.MOCK_PANTA = "true";
delete process.env.VERCEL_ENV;
