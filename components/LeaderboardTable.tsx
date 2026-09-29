import type { PreviewRow } from "@/lib/leaderboard-preview";
import { CreatorFlag } from "./CreatorFlag";
import { StreakTicks } from "./StreakTicks";
import { ago, shortAddr } from "./format";
import { HitRate, Tag } from "./ui/Badge";
import { cn } from "./ui/cn";

const rankLabel = (n: number) => String(n).padStart(2, "0");

/**
 * Leaderboard. Desktop: a real <table> with right-aligned mono numbers.
 * Mobile: a purpose-built two-line row (not a squashed table).
 * `sample` labels fixture data honestly.
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
    <section aria-labelledby="lb-title" className="card overflow-hidden">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2 border-b border-line px-4 pb-4 pt-5 sm:px-6">
        <div>
          <h2 id="lb-title" className="font-display text-[2rem] leading-8 tracking-[-0.01em]">
            Leaderboard
          </h2>
          <p className="mt-1.5 text-sm text-fg-muted">
            Ranked by hit rate on resolved calls. Minimum <span className="num text-fg">{minResolved}</span> resolved.
          </p>
        </div>
        {sample && <Tag>Sample data</Tag>}
      </div>

      {rows.length === 0 ? (
        <p className="px-6 py-12 text-center text-fg-muted">No traders qualify yet.</p>
      ) : (
        <>
          {/* Desktop / tablet */}
          <table className="hidden w-full text-sm sm:table">
            <caption className="sr-only">Top callers by hit rate</caption>
            <thead>
              <tr className="label border-b border-line text-left text-fg-subtle">
                <th scope="col" className="w-14 py-2.5 pl-6 font-medium">
                  #
                </th>
                <th scope="col" className="py-2.5 font-medium">
                  Trader
                </th>
                <th scope="col" className="hidden py-2.5 font-medium md:table-cell">
                  Last calls
                </th>
                <th scope="col" className="py-2.5 text-right font-medium">
                  Hit rate
                </th>
                <th scope="col" className="py-2.5 text-right font-medium">
                  W–L
                </th>
                <th scope="col" className="hidden py-2.5 text-right font-medium lg:table-cell">
                  Open
                </th>
                <th scope="col" className="py-2.5 pr-6 text-right font-medium">
                  Last
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((r) => (
                <tr key={r.wallet} className="group transition-colors hover:bg-white/[0.025]">
                  <td className={cn("num py-3.5 pl-6", r.rank <= 3 ? "text-brand-300" : "text-fg-subtle")}>
                    {rankLabel(r.rank)}
                  </td>
                  <td className="py-3.5">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="num text-fg" title={r.wallet}>
                        {shortAddr(r.wallet)}
                      </span>
                      {r.creatorTradeCount > 0 && (
                        <CreatorFlag count={r.creatorTradeCount} verified={r.creatorVerified} />
                      )}
                    </div>
                  </td>
                  <td className="hidden py-3.5 md:table-cell">
                    <StreakTicks results={r.streak} />
                  </td>
                  <td className="py-3.5 text-right text-lg">
                    <HitRate hitRate={r.hitRate} />
                  </td>
                  <td className="num py-3.5 text-right text-fg-muted">
                    {r.correctCalls}
                    <span className="text-fg-subtle">–</span>
                    {r.resolvedCalls - r.correctCalls}
                  </td>
                  <td className="num hidden py-3.5 text-right text-fg-muted lg:table-cell">{r.openPositions}</td>
                  <td className="num py-3.5 pr-6 text-right text-fg-subtle">{ago(r.lastActive, nowSec)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Phone */}
          <ol className="divide-y divide-line sm:hidden">
            {rows.map((r) => (
              <li key={r.wallet} className="grid grid-cols-[2rem_1fr_auto] gap-x-2 px-4 py-3.5">
                <span className={cn("num pt-0.5 text-sm", r.rank <= 3 ? "text-brand-300" : "text-fg-subtle")}>
                  {rankLabel(r.rank)}
                </span>
                <div className="min-w-0">
                  <p className="num text-[15px] text-fg">{shortAddr(r.wallet)}</p>
                  <div className="mt-2 flex items-center gap-3">
                    <StreakTicks results={r.streak} />
                    <span className="num text-xs text-fg-subtle">
                      {r.correctCalls}–{r.resolvedCalls - r.correctCalls} · {ago(r.lastActive, nowSec)}
                    </span>
                  </div>
                  {r.creatorTradeCount > 0 && (
                    <CreatorFlag count={r.creatorTradeCount} verified={r.creatorVerified} className="mt-2" />
                  )}
                </div>
                <div className="text-right">
                  <HitRate hitRate={r.hitRate} className="text-2xl leading-7" />
                  <p className="label mt-0.5 text-fg-subtle">{r.resolvedCalls} calls</p>
                </div>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
