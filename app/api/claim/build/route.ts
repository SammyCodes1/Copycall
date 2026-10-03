import { authErrorResponse } from "@/lib/auth";
import { buildClaimTx } from "@/lib/copy-core";
import { ensureMockData, json } from "@/lib/data";
import { getFlowDeps } from "@/lib/flow";
import { flushOpsAlerts } from "@/lib/ops-alert";

/** POST /api/claim/build { marketId } - win claim for the SESSION wallet; same checks as a copy. */
export async function POST(request: Request) {
  try {
    await ensureMockData();
    return json(await buildClaimTx(getFlowDeps(), request));
  } catch (err) {
    return authErrorResponse(err);
  } finally {
    await flushOpsAlerts(); // bounded (5 s per post); a no-op unless an alert was queued
  }
}
