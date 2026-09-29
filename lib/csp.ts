/**
 * Content-Security-Policy builder (addendum K + security audit F-02).
 * Used by proxy.ts, which generates a fresh nonce for every request.
 *
 * - script-src: no 'unsafe-inline'. Next.js reads the nonce from the request's
 *   CSP header and puts it on its own inline bootstrap scripts; 'strict-dynamic'
 *   lets those trusted scripts load our /_next chunks. 'self' is kept as a
 *   fallback for browsers without 'strict-dynamic'. 'unsafe-eval' in dev only
 *   (React uses eval for debug stacks there).
 * - style-src keeps 'unsafe-inline': React `style` attributes and the wallet
 *   adapter's inline styles can't carry nonces. Style injection can't run code.
 * - connect-src 'self' only: the browser talks to our API routes, never to
 *   Panta, Supabase or the RPC directly.
 * - frame-src allows Solflare's hosted connect iframe.
 */
export function buildCsp(nonce: string, isDev: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self'${isDev ? " ws:" : ""}`,
    "frame-src https://connect.solflare.com",
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(isDev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}

/** Strict policy for non-HTML responses (API JSON): nothing may load or frame it. */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'";

/** 128-bit random nonce, base64. Works in both the Node and Edge runtimes. */
export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
