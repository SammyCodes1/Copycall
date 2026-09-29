import { NextResponse } from "next/server";
import { assertSameOrigin } from "@/lib/auth-core";
import { authErrorResponse, sessionCookieOptions } from "@/lib/auth";
import { getAppOrigin } from "@/lib/env";
import { SESSION_COOKIE } from "@/lib/session";

/** POST /api/auth/logout -> clears the session cookie */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request, getAppOrigin());
    const res = NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    res.cookies.set(SESSION_COOKIE, "", sessionCookieOptions(0));
    return res;
  } catch (err) {
    return authErrorResponse(err);
  }
}
