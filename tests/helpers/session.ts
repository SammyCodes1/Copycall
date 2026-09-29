import { issueNonce, verifyLogin } from "@/lib/auth-core";
import { getAuthDeps } from "@/lib/auth";
import { SESSION_COOKIE } from "@/lib/session";
import { APP_ORIGIN, jsonRequest, testWallet } from "./wallet";

let ip = 1;

/** Sign a fresh test wallet in through the real nonce flow (shared mock stores). */
export async function signedInUser() {
  const w = testWallet();
  const headers = { "x-forwarded-for": `192.0.2.${ip++ % 250}` };
  const d = getAuthDeps();
  const { nonce, message } = await issueNonce(d, jsonRequest("/api/auth/nonce", { wallet: w.address }, headers));
  const res = await verifyLogin(d, jsonRequest("/api/auth/verify", { wallet: w.address, nonce, signature: w.sign(message) }, headers));
  return { wallet: w.address, userId: res.userId, token: res.token, cookie: `${SESSION_COOKIE}=${res.token}` };
}

/** A request like the browser sends: JSON body, Origin, optional session cookie. */
export function apiRequest(
  method: string,
  path: string,
  opts: { body?: unknown; cookie?: string; origin?: string | null } = {},
): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.origin !== null) headers.origin = opts.origin ?? APP_ORIGIN;
  if (opts.cookie) headers.cookie = opts.cookie;
  return new Request(`${APP_ORIGIN}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}
