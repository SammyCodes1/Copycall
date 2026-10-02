// Test-only preload (node --import): no real network. Panta's live host answers with
// STUB_PANTA_STATUS / STUB_PANTA_BODY; every other fetch fails. Used by tests/panta-error-output.test.ts.
const status = Number(process.env.STUB_PANTA_STATUS ?? "400");
const body = process.env.STUB_PANTA_BODY ?? "";
globalThis.fetch = async (input) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.hostname !== "live-api.panta.market") throw new TypeError("fetch failed (network disabled in tests)");
  return new Response(body, { status, headers: { "content-type": "application/json" } });
};
