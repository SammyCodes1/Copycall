import { NextResponse, type NextRequest } from "next/server";
import { buildCsp, generateNonce } from "./lib/csp";

/**
 * Per-request CSP nonce (security audit F-02). The policy is set on the
 * request headers (Next.js reads the nonce from there and applies it to the
 * scripts it renders) and on the response. `x-nonce` lets server components
 * read it if they ever need to render their own <Script>.
 * The other security headers stay in next.config.ts.
 */
export function proxy(request: NextRequest) {
  const nonce = generateNonce();
  const csp = buildCsp(nonce, process.env.NODE_ENV === "development");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    {
      // Everything except API routes (strict static CSP in next.config.ts),
      // static chunks, image optimisation and the favicon.
      source: "/((?!api|_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
