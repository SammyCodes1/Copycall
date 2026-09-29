import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron-auth";
import { ensureMockData, getAlertDeps } from "@/lib/data";
import { readEnv } from "@/lib/env";
import { runAlerts } from "@/lib/sync";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * GET /api/cron/alerts - every 2 minutes (vercel.json). Polls followed wallets,
 * creates alerts for new buys and sends them (or logs them without Telegram).
 * Auth: Authorization: Bearer CRON_SECRET only (addendum D).
 */
export async function GET(request: Request) {
  if (!isAuthorizedCron(request, readEnv().CRON_SECRET)) return unauthorizedCron();
  try {
    await ensureMockData();
    const summary = await runAlerts(await getAlertDeps());
    return Response.json({ ok: true, summary }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[cron/alerts] failed", err instanceof Error ? err.message : "error");
    return Response.json({ ok: false, code: "ALERTS_FAILED" }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
