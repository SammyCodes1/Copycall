import { NextResponse } from "next/server";
import { issueNonce } from "@/lib/auth-core";
import { authErrorResponse, getAuthDeps } from "@/lib/auth";

/** POST /api/auth/nonce  body: { wallet } -> { nonce, message, expiresAt } */
export async function POST(request: Request) {
  try {
    const result = await issueNonce(getAuthDeps(), request);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return authErrorResponse(err);
  }
}
