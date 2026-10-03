/**
 * Output redaction shared by scripts/panta-build-check.mjs and scripts/panta-fee-model.mjs
 * (K-03): strips the Panta key, the full RPC URL and every sensitive piece of it (credentials,
 * query values, long path segments, origin+path), anything shaped like a Panta key, and
 * api-key/token/secret/auth query values.
 */

/** Secrets to strip from output: every sensitive piece of the RPC URL. */
export function secretsFromRpcUrl(raw) {
  const out = [];
  if (!raw) return out;
  out.push(raw);
  try {
    const u = new URL(raw);
    if (u.username) out.push(decodeURIComponent(u.username), u.username);
    if (u.password) out.push(decodeURIComponent(u.password), u.password);
    for (const [, v] of u.searchParams) if (v.length >= 4) out.push(v, encodeURIComponent(v));
    for (const seg of u.pathname.split("/")) if (seg.length >= 8) out.push(seg);
    out.push(`${u.origin}${u.pathname}`);
  } catch {
    /* not a URL: the whole string is still redacted */
  }
  return out;
}

/** A redact(text) for this Panta key and RPC URL (either may be empty). */
export function makeRedact(pantaKey, rpcUrl) {
  const secrets = [...(pantaKey ? [pantaKey] : []), ...secretsFromRpcUrl(rpcUrl)]
    .filter((s) => s.length >= 4)
    .sort((a, b) => b.length - a.length);
  return function redact(text) {
    let s = String(text);
    for (const k of secrets) s = s.split(k).join("[redacted]");
    return s
      .replace(/pk_(test|live)_[A-Za-z0-9_\-]+/g, "pk_$1_[redacted]")
      .replace(/(api[-_]?key|token|secret|auth)=([^&\s"']+)/gi, "$1=[redacted]");
  };
}
