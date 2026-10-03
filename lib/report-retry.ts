/**
 * B3-07: reporting recorded copies and claims to Panta (POST /trades/).
 *
 * The copy/claim is always recorded first, so user state never depends on
 * Panta. A report that fails at confirm is retried by the alerts cron with
 * exponential backoff (baseGapSec * 2^(attempts-1)) and a hard attempt cap.
 * Panta dedupes per signature, so a retry after a lost response is harmless.
 *
 * TX_FEE_MISMATCH (and TX_MISMATCH) mean Panta's own on-chain verification
 * disagrees with what we recorded: that is a security signal, so it raises an
 * ALERT and is never retried. TX_FAILED is permanent too.
 *
 * Pure module: store, Panta and logging are injected.
 */
import type { CopyStore, ReportJob, ReportRetryPolicy } from "./copy-store";
import { opsAlert, type AlertTag } from "./ops-alert";
import { PantaError } from "./panta-error";
import type { ReportTradeRequest, ReportTradeResponse } from "./schemas";

export const REPORT_RETRY: ReportRetryPolicy = { limit: 20, maxAttempts: 5, baseGapSec: 110, maxAgeSec: 24 * 60 * 60 };
/** Never retried. */
export const REPORT_STOP_CODES: ReadonlySet<string> = new Set(["TX_FEE_MISMATCH", "TX_MISMATCH", "TX_FAILED"]);
/** Raise an operator alert. */
export const REPORT_ALERT_CODES: ReadonlySet<string> = new Set(["TX_FEE_MISMATCH", "TX_MISMATCH"]);

export type ReportDeps = {
  copy: Pick<CopyStore, "markReported" | "recordReportFailure" | "claimReportRetries">;
  panta: { reportTrade(req: ReportTradeRequest): Promise<ReportTradeResponse> };
  log?: (m: string) => void;
  /** Operator alert (default: opsAlert: the [ALERT] log, plus the sanitized webhook post). */
  alert?: (m: string, tag?: AlertTag) => void;
};

export type ReportOutcome = "reported" | "retry" | "stopped";

const short = (sig: string) => `${sig.slice(0, 8)}…`;

/** One report attempt. Never throws. */
export async function reportOnce(
  d: ReportDeps,
  job: Omit<ReportJob, "attempts"> & { attempts: number },
  policy: ReportRetryPolicy = REPORT_RETRY,
): Promise<ReportOutcome> {
  try {
    await d.panta.reportTrade({
      signature: job.signature,
      wallet: job.wallet,
      marketId: job.marketId,
      ...(job.quoteId ? { quoteId: job.quoteId } : {}),
    });
    await d.copy.markReported(job.orderId);
    return "reported";
  } catch (err) {
    const code = err instanceof PantaError && /^[A-Z_]{1,40}$/.test(err.code) ? err.code : "ERROR";
    const stop = REPORT_STOP_CODES.has(code);
    if (REPORT_ALERT_CODES.has(code)) {
      const alert = d.alert ?? opsAlert;
      alert(`Panta refused the ${job.kind} report for ${short(job.signature)} with ${code}; not retrying`, {
        event: "REPORT_REFUSED",
        code,
        kind: job.kind,
        id: job.orderId,
      });
    }
    d.log?.(`${job.kind} report failed for ${short(job.signature)} (attempt ${job.attempts}): ${code}`);
    try {
      await d.copy.recordReportFailure(job.orderId, code, stop, policy.maxAttempts);
    } catch {
      d.log?.(`${job.kind} report failure not recorded for ${short(job.signature)}`);
    }
    return stop || job.attempts >= policy.maxAttempts ? "stopped" : "retry";
  }
}

export type ReportRetrySummary = { claimed: number; reported: number; retry: number; stopped: number };

/** Cron step: report every due, unreported copy/claim once. */
export async function runReportRetries(
  d: ReportDeps,
  policy: ReportRetryPolicy = REPORT_RETRY,
): Promise<ReportRetrySummary> {
  const jobs = await d.copy.claimReportRetries(policy);
  const summary: ReportRetrySummary = { claimed: jobs.length, reported: 0, retry: 0, stopped: 0 };
  for (const job of jobs) summary[await reportOnce(d, job, policy)]++;
  return summary;
}
