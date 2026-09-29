import type { NextConfig } from "next";
import { assertBootSafe } from "./lib/boot";
import { API_CSP } from "./lib/csp";

// Refuse to build or start a production deployment in mock mode (addendum I).
// instrumentation.ts repeats this check at server start.
assertBootSafe(process.env);

/**
 * Content-Security-Policy lives in proxy.ts (per-request nonce, see lib/csp.ts).
 * API routes are excluded from the proxy and get a strict static policy here.
 * These other headers apply to every response.
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      { source: "/api/:path*", headers: [{ key: "Content-Security-Policy", value: API_CSP }] },
    ];
  },
};

export default nextConfig;
