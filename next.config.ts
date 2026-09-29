import type { NextConfig } from "next";
import { assertBootSafe } from "./lib/boot";

// Refuse to build or start a production deployment in mock mode (addendum I).
// instrumentation.ts repeats this check at server start.
assertBootSafe(process.env);

const isDev = process.env.NODE_ENV === "development";

/**
 * Content-Security-Policy (addendum K).
 * - Next.js injects inline bootstrap scripts, so without per-request nonces we
 *   need 'unsafe-inline' for scripts; 'unsafe-eval' only in dev (React debug).
 * - connect-src is 'self' only: the browser talks to our API routes, never to
 *   Panta, Supabase or the RPC directly.
 * - frame-src allows Solflare's hosted connect iframe (used when the Solflare
 *   extension is not installed).
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  `connect-src 'self'${isDev ? " ws:" : ""}`,
  "frame-src https://connect.solflare.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  ...(isDev ? [] : ["upgrade-insecure-requests"]),
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
