import type { PreviewRow } from "@/lib/leaderboard-preview";
import { CreatorFlag } from "./CreatorFlag";
import { HitRateBadge } from "./ui/Badge";
import { GlassCard } from "./ui/GlassCard";

function short(a: string) {
  return `${a.slice(0, 4)}…${a.slice(-4)}`;
}

function relativeDays(unix: number | null, nowSec: number) {
  if (unix === null) return "—";
  const d = Math.max(0, Math.round((nowSec - unix) / 86400));
  return d === 0 ? "today" : d === 1 ? "1d ago" : `${d}d ago`;
}

/** Deterministic gradient avatar from the wallet string (no external images). */
function Avatar({ wallet }: { wallet: string }) {
  let h = 0;
  for (const c of wallet) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const hue = 95 + (h % 70); // stays in Panta's green/lime family
  return (
    <span
      aria-hidden
      className="size-9 shrink-0 rounded-full ring-1 ring-white/15"
      style={{
        background: `radial-gradient(circle at 30% 30%, hsl(${hue} 70% 62%), hsl(${hue + 25} 60% 28%) 70%)`,
      }}
    />
  );
}

/**
 * Leaderboard list. Mobile: stacked cards. >= sm: table-like grid.
 * `sample` labels the data honestly as fixtures.
 */
export function LeaderboardTable({
  rows,
  nowSec,
  sample,
  minResolved,
}: {
  rows: PreviewRow[];
  nowSec: number;
  sample?: boolean;
  minResolved: number;
}) {
  return (
    <GlassCard as="section" aria-labelledby="lb-title" className="overflow-hidden">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-white/[0.07] px-4 py-4 sm:px-6">
        <div>
          <h2 id="lb-title" className="font-display text-xl font-semibold tracking-tight sm:text-2xl">
            Top callers
          </h2>
          <p className="mt-1 text-sm text-fg-muted">Ranked by hit rate · min {minResolved} resolved calls</p>
        </div>
        {sample && (
          <span className="rounded-[var(--radius-pill)] bg-white/[0.06] px-2.5 py-1 text-xs font-semibold text-fg-muted ring-1 ring-inset ring-white/10">
            Sample data
          </span>
        )}
      </div>

      {rows.length === 0 ? (
        <p className="px-6 py-12 text-center text-fg-muted">No traders qualify yet.</p>
      ) : (
        <>
          <div
            aria-hidden="true"
            className="hidden grid-cols-[3rem_minmax(0,1.6fr)_minmax(0,1.3fr)_5rem_6rem] gap-4 px-6 py-3 text-xs font-semibold uppercase tracking-wider text-fg-subtle sm:grid"
          >
            <span>#</span>
            <span>Trader</span>
            <span>Hit rate</span>
            <span className="text-right">Open</span>
            <span className="text-right">Active</span>
          </div>
          <ol className="divide-y divide-white/[0.06]">
            {rows.map((r, i) => (
              <li
                key={r.wallet}
                className="animate-fade-up px-4 py-4 transition-colors hover:bg-white/[0.03] sm:grid sm:grid-cols-[3rem_minmax(0,1.6fr)_minmax(0,1.3fr)_5rem_6rem] sm:items-center sm:gap-4 sm:px-6"
                style={{ animationDelay: `${Math.min(i, 8) * 45}ms` }}
              >
                <div className="flex items-center gap-3 sm:contents">
                  <span
                    className={
                      "w-6 shrink-0 font-display text-lg font-semibold tabular-nums sm:w-auto " +
                      (r.rank <= 3 ? "text-brand-300" : "text-fg-subtle")
                    }
                  >
                    {r.rank}
                  </span>
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <Avatar wallet={r.wallet} />
                    <div className="min-w-0">
                      <p className="truncate font-mono text-sm font-medium tabular-nums text-fg" title={r.wallet}>
                        {short(r.wallet)}
                      </p>
                      {r.creatorTradeCount > 0 && (
                        <span className="mt-1.5 hidden sm:block">
                          <CreatorFlag count={r.creatorTradeCount} verified={r.creatorVerified} />
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="sm:hidden">
                    <HitRateBadge hitRate={r.hitRate} calls={r.resolvedCalls} />
                  </div>
                </div>
                <div className="hidden sm:block">
                  <HitRateBadge hitRate={r.hitRate} calls={r.resolvedCalls} />
                </div>
                {r.creatorTradeCount > 0 && (
                  <div className="mt-2.5 pl-9 sm:hidden">
                    <CreatorFlag count={r.creatorTradeCount} verified={r.creatorVerified} />
                  </div>
                )}
                <p className="mt-2 flex gap-4 pl-9 text-xs text-fg-subtle tabular-nums sm:contents">
                  <span className="sm:text-right sm:text-sm sm:text-fg-muted">
                    <span className="sm:sr-only">Open </span>
                    {r.openPositions}
                  </span>
                  <span className="sm:text-right sm:text-sm sm:text-fg-muted">
                    <span className="sm:sr-only">Active </span>
                    {relativeDays(r.lastActive, nowSec)}
                  </span>
                </p>
              </li>
            ))}
          </ol>
        </>
      )}
    </GlassCard>
  );
}
