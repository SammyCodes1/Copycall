import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { logout } from "@/lib/auth-core";
import { authErrorResponse, getAuthDeps, sessionCookieOptions } from "@/lib/auth";
import { SESSION_COOKIE } from "@/lib/session";

/**
 * POST /api/auth/logout -> revokes the session server-side (bumps the user's
 * session_version) and clears the cookie.
 */
export async function POST(request: Request) {
  try {
    const token = (await cookies()).get(SESSION_COOKIE)?.value;
    await logout(getAuthDeps(), request, token);
    const res = NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    res.cookies.set(SESSION_COOKIE, "", sessionCookieOptions(0));
    return res;
  } catch (err) {
    return authErrorResponse(err);
  }
}
