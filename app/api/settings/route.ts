import { authErrorResponse } from "@/lib/auth";
import { getUserDeps, json } from "@/lib/data";
import { readSettings, writeSettings } from "@/lib/user-core";
import { stakeCapOrNull } from "@/lib/flow";

/** GET /api/settings - the signed-in user's settings. */
export async function GET(request: Request) {
  try {
    return json(await readSettings(getUserDeps(), request));
  } catch (err) {
    return authErrorResponse(err);
  }
}

/** PUT /api/settings { maxStakeUsdc, slippageBps (<= 500), alertsEnabled }. Session + Origin required. */
export async function PUT(request: Request) {
  try {
    return json(await writeSettings(getUserDeps(), request, stakeCapOrNull()));
  } catch (err) {
    return authErrorResponse(err);
  }
}
