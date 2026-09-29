import { NextResponse } from "next/server";
import { verifyLogin } from "@/lib/auth-core";
import { authErrorResponse, getAuthDeps, sessionCookieOptions } from "@/lib/auth";
import { SESSION_COOKIE } from "@/lib/session";

/** POST /api/auth/verify  body: { wallet, nonce, signature } -> sets the session cookie */
export async function POST(request: Request) {
  try {
    const { wallet, token } = await verifyLogin(getAuthDeps(), request);
    const res = NextResponse.json({ wallet }, { headers: { "Cache-Control": "no-store" } });
    res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
    return res;
  } catch (err) {
    return authErrorResponse(err);
  }
}
