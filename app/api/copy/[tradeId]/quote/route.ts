import { authErrorResponse } from "@/lib/auth";
import { quoteCopy } from "@/lib/copy-core";
import { ensureMockData, json } from "@/lib/data";
import { getFlowDeps } from "@/lib/flow";

export const dynamic = "force-dynamic";

/**
 * GET /api/copy/[tradeId]/quote - re-quote the stored leader trade with the
 * follower's saved max stake and slippage. Query parameters are ignored:
 * side, market and amount never come from the request. 10/min per user,
 * cached 10 s (addendum H).
 */
export async function GET(request: Request, ctx: RouteContext<"/api/copy/[tradeId]/quote">) {
  try {
    await ensureMockData();
    const { tradeId } = await ctx.params;
    return json(await quoteCopy(getFlowDeps(), request, tradeId));
  } catch (err) {
    return authErrorResponse(err);
  }
}
