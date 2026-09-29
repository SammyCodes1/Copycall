import { authErrorResponse } from "@/lib/auth";
import { myPositions } from "@/lib/copy-core";
import { ensureMockData, json } from "@/lib/data";
import { getFlowDeps } from "@/lib/flow";

export const dynamic = "force-dynamic";

/** GET /api/positions - the signed-in wallet's positions and copies. No wallet parameter exists. */
export async function GET(request: Request) {
  try {
    await ensureMockData();
    return json(await myPositions(getFlowDeps(), request));
  } catch (err) {
    return authErrorResponse(err);
  }
}
