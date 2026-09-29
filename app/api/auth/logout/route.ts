import { NextResponse } from "next/server";
import { logout } from "@/lib/auth-core";
import { authErrorResponse, getAuthDeps, sessionCookieOptions } from "@/lib/auth";
import { SESSION_COOKIE } from "@/lib/session";
import { sessionTokenFrom } from "@/lib/user-core";

/**
 * POST /api/auth/logout -> revokes the session server-side (bumps the user's
 * session_version) and clears the cookie.
 */
export async function POST(request: Request) {
  try {
    const token = sessionTokenFrom(request); // same cookie, read from the request (testable)
    await logout(getAuthDeps(), request, token);
    const res = NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    res.cookies.set(SESSION_COOKIE, "", sessionCookieOptions(0));
    return res;
  } catch (err) {
    return authErrorResponse(err);
  }
}
