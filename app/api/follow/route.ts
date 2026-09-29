import { authErrorResponse } from "@/lib/auth";
import { ensureMockData, getUserDeps, json } from "@/lib/data";
import { followTrader, unfollowTrader } from "@/lib/user-core";

/** POST /api/follow { wallet } - follow a tracked trader. Session + Origin required. */
export async function POST(request: Request) {
  try {
    await ensureMockData();
    return json(await followTrader(getUserDeps(), request));
  } catch (err) {
    return authErrorResponse(err);
  }
}

/** DELETE /api/follow { wallet } - unfollow. Session + Origin required. */
export async function DELETE(request: Request) {
  try {
    return json(await unfollowTrader(getUserDeps(), request));
  } catch (err) {
    return authErrorResponse(err);
  }
}
