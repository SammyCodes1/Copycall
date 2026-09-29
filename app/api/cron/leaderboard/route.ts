import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron-auth";
import { getSyncDeps } from "@/lib/data";
import { readEnv } from "@/lib/env";
import { runLeaderboardSync } from "@/lib/sync";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // seconds (Vercel); the job stops early on its own budget

/**
 * GET /api/cron/leaderboard - scheduled every 10-15 minutes (vercel.json).
 * Auth: Authorization: Bearer CRON_SECRET only (addendum D).
 */
export async function GET(request: Request) {
  if (!isAuthorizedCron(request, readEnv().CRON_SECRET)) return unauthorizedCron();
  try {
    const summary = await runLeaderboardSync(getSyncDeps());
    return Response.json({ ok: true, summary }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[cron/leaderboard] failed", err instanceof Error ? err.message : "error");
    return Response.json({ ok: false, code: "SYNC_FAILED" }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
