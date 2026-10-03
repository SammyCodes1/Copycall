/** Error thrown by lib/panta.ts (and the mock) carrying Panta's `code` from the error envelope. */
export class PantaError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** P1-5: the envelope's `field` (which request field Panta rejected), when it sent one. */
    readonly field?: string,
    /** The envelope's `fields` (serializer errors), any shape. Only its NAMES are ever printed. */
    readonly fields?: unknown,
  ) {
    super(message);
    this.name = "PantaError";
  }
}

/** Codes are printed only in this shape; anything else from the network is "(unprintable)". */
const PRINTABLE_CODE = /^[A-Z_]{1,64}$/;
/** Our own code when the error body wasn't a Panta envelope (lib/panta.ts): HTTP_<status>. */
const UNPARSED_ENVELOPE_CODE = /^HTTP_\d{3}$/;
const PRINTABLE_FIELD = /^[A-Za-z_]{1,64}$/;
/** `fields` names: only these characters; a name with anything else is dropped, not shown. */
const FIELD_NAME = /^[A-Za-z0-9_.]{1,64}$/;
const FIELDS_MAX_NAMES = 10;
const FIELDS_MAX_LEN = 200;
const UNSAFE_NAMES = new Set(["__proto__", "constructor", "prototype"]);
/** Names that look like credentials or URLs are never printed, even in the allowed charset. */
const SECRETISH = /(^|[._])(pk|sk)_|api.?key|secret|token|passw|bearer|helius|https?|rpc/i;

function printableName(name: string): boolean {
  if (!FIELD_NAME.test(name) || UNSAFE_NAMES.has(name) || SECRETISH.test(name)) return false;
  const key = (process.env.PANTA_API_KEY ?? "").trim();
  return !(key.length >= 8 && (name.includes(key.slice(0, 8)) || key.includes(name)));
}

/** ` fields=[a,b]` (names only, at most 10, segment <= 200 chars), or ` fields=unparsed`. */
function fieldsSegment(fields: unknown): string {
  let names: unknown[];
  if (Array.isArray(fields) && fields.every((x) => typeof x === "string")) names = fields;
  else if (fields !== null && typeof fields === "object" && !Array.isArray(fields)) {
    const proto = Object.getPrototypeOf(fields);
    if (proto !== Object.prototype && proto !== null) return " fields=unparsed";
    names = Object.keys(fields);
  } else return " fields=unparsed";
  const shown: string[] = [];
  let seg = " fields=[]";
  for (const n of names) {
    if (shown.length >= FIELDS_MAX_NAMES) break;
    if (typeof n !== "string" || !printableName(n) || shown.includes(n)) continue;
    const next = ` fields=[${[...shown, n].join(",")}]`;
    if (next.length > FIELDS_MAX_LEN) break;
    shown.push(n);
    seg = next;
  }
  return seg;
}

/**
 * P1-5: one line for the check scripts: `name: message`, plus ` code=<CODE>` for a PantaError
 * (or any error with a string `code`) and ` field=<name>` when Panta named one. Network-supplied
 * values are printed only when they match the strict shapes above, never raw. `code=HTTP_<status>`
 * means the error body did not parse as a Panta envelope; a parsed envelope keeps Panta's code.
 * ` fields=[a,b]` lists only the NAMES of the envelope's `fields` (never their values): each must
 * be [A-Za-z0-9_.]{1,64}, not __proto__/constructor/prototype, not credential- or URL-like; at
 * most 10, segment <= 200 chars. A `fields` that is neither a plain object nor an array of
 * strings prints ` fields=unparsed`.
 */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  let s = `${err.name}: ${err.message}`;
  const { code, field, fields } = err as { code?: unknown; field?: unknown; fields?: unknown };
  // instanceof can fail across separately loaded module graphs, so the shape counts too.
  if (err instanceof PantaError || typeof code === "string") {
    const ok = typeof code === "string" && (PRINTABLE_CODE.test(code) || UNPARSED_ENVELOPE_CODE.test(code));
    s += ` code=${ok ? code : "(unprintable)"}`;
    if (typeof field === "string" && PRINTABLE_FIELD.test(field)) s += ` field=${field}`;
    if (fields !== undefined) s += fieldsSegment(fields);
  }
  return s;
}
