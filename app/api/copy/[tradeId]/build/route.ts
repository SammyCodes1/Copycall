import { authErrorResponse } from "@/lib/auth";
import { buildCopy } from "@/lib/copy-core";
import { ensureMockData, json } from "@/lib/data";
import { getFlowDeps } from "@/lib/flow";
import { flushOpsAlerts } from "@/lib/ops-alert";

/**
 * POST /api/copy/[tradeId]/build { quoteToken } - Panta builds, we assemble,
 * validate (addendum A) and simulate, then return the exact base64 tx to sign.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/copy/[tradeId]/build">) {
  try {
    await ensureMockData();
    const { tradeId } = await ctx.params;
    return json(await buildCopy(getFlowDeps(), request, tradeId));
  } catch (err) {
    return authErrorResponse(err);
  } finally {
    await flushOpsAlerts(); // bounded (5 s per post); a no-op unless an alert was queued
  }
}
