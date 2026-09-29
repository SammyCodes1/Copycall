/** Error thrown by lib/panta.ts (and the mock) carrying Panta's `code` from the error envelope. */
export class PantaError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PantaError";
  }
}
