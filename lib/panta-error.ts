/** Error thrown by lib/panta.ts (and the mock) carrying Panta's `code` from the error envelope. */
export class PantaError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** P1-5: the envelope's `field` (which request field Panta rejected), when it sent one. */
    readonly field?: string,
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

/**
 * P1-5: one line for the check scripts: `name: message`, plus ` code=<CODE>` for a PantaError
 * (or any error with a string `code`) and ` field=<name>` when Panta named one. Network-supplied
 * values are printed only when they match the strict shapes above, never raw. `code=HTTP_<status>`
 * means the error body did not parse as a Panta envelope; a parsed envelope keeps Panta's code.
 */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  let s = `${err.name}: ${err.message}`;
  const { code, field } = err as { code?: unknown; field?: unknown };
  // instanceof can fail across separately loaded module graphs, so the shape counts too.
  if (err instanceof PantaError || typeof code === "string") {
    const ok = typeof code === "string" && (PRINTABLE_CODE.test(code) || UNPARSED_ENVELOPE_CODE.test(code));
    s += ` code=${ok ? code : "(unprintable)"}`;
    if (typeof field === "string" && PRINTABLE_FIELD.test(field)) s += ` field=${field}`;
  }
  return s;
}
