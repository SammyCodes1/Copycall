import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron-auth";
import { ensureMockData, getAlertDeps } from "@/lib/data";
import { readEnv } from "@/lib/env";
import { sweepBroadcastOrders, type SweepSummary } from "@/lib/copy-core";
import { getFlowDeps, getReportDeps } from "@/lib/flow";
import { flushOpsAlerts } from "@/lib/ops-alert";
import { runReportRetries, type ReportRetrySummary } from "@/lib/report-retry";
import { runAlerts } from "@/lib/sync";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * GET /api/cron/alerts - every 2 minutes (vercel.json). Polls followed wallets,
 * creates alerts for new buys and sends them (or logs them without Telegram).
 * Then verifies broadcast-but-unrecorded orders (E-02) and retries failed Panta
 * trade reports (B3-07, bounded; lib/report-retry.ts).
 * Auth: Authorization: Bearer CRON_SECRET only (addendum D).
 */
export async function GET(request: Request) {
  if (!isAuthorizedCron(request, readEnv().CRON_SECRET)) return unauthorizedCron();
  try {
    await ensureMockData();
    const summary = await runAlerts(await getAlertDeps());
    // Separate steps: a sweep or report-retry problem never fails the alerts run.
    let sweep: SweepSummary | { error: string };
    try {
      sweep = await sweepBroadcastOrders(getFlowDeps());
    } catch (err) {
      console.error("[cron/alerts] order sweep failed", err instanceof Error ? err.message : "error");
      sweep = { error: "SWEEP_FAILED" };
    }
    let reports: ReportRetrySummary | { error: string };
    try {
      reports = await runReportRetries(getReportDeps());
    } catch (err) {
      console.error("[cron/alerts] report retries failed", err instanceof Error ? err.message : "error");
      reports = { error: "REPORT_RETRY_FAILED" };
    }
    return Response.json({ ok: true, summary, sweep, reports }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[cron/alerts] failed", err instanceof Error ? err.message : "error");
    return Response.json({ ok: false, code: "ALERTS_FAILED" }, { status: 500, headers: { "Cache-Control": "no-store" } });
  } finally {
    await flushOpsAlerts(); // serverless: deliver queued operator alerts before the run ends (bounded)
  }
}
