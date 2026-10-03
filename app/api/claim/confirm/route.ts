import { authErrorResponse } from "@/lib/auth";
import { confirmOrder } from "@/lib/copy-core";
import { json } from "@/lib/data";
import { getFlowDeps } from "@/lib/flow";
import { flushOpsAlerts } from "@/lib/ops-alert";

/**
 * POST /api/claim/confirm { orderId, signedTransaction | signature | simulated }
 * Broadcasts on our RPC (never from the browser), then verifies the landed
 * transaction on chain (addendum C) before reporting to Panta and recording it.
 * 202 = still landing; call again with { orderId, signature }.
 */
export async function POST(request: Request) {
  try {
    const result = await confirmOrder(getFlowDeps(), request, "claim");
    return json(result, result.status === "pending" ? 202 : 200);
  } catch (err) {
    return authErrorResponse(err);
  } finally {
    await flushOpsAlerts(); // bounded (5 s per post); a no-op unless an alert was queued
  }
}
