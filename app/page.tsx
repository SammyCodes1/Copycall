import { CopyReview } from "@/components/CopyReview";
import { LeaderboardTable } from "@/components/LeaderboardTable";
import { Tape } from "@/components/Tape";
import { WalletButton } from "@/components/WalletButton";
import { Tag } from "@/components/ui/Badge";
import { getSession } from "@/lib/auth";
import { isMockMode } from "@/lib/env";
import { FIXTURE_NOW, getSampleCopy } from "@/lib/leaderboard-preview";
import { displayNowSec, getCounts, getLeaderboard, getTape } from "@/lib/queries";
import { ago } from "@/components/format";

const ANATOMY = [
  {
    n: "1",
    t: "The leader's call, from our records",
    d: "The alert link carries only a trade ID. Market and side are loaded from the stored trade, so an edited link can't change what you buy. Creator trades are flagged.",
  },
  {
    n: "2",
    t: "Re-quoted for you, right now",
    d: "Priced with your own max stake and slippage cap (2% default, 5% hard limit). The leader's entry price isn't in Panta's data, so we say so.",
  },
  {
    n: "3",
    t: "You sign. Nothing is automatic.",
    d: "The server checks the transaction before your wallet sees it: known programs only, you as fee payer, spend within your stake.",
  },
];

export default async function Home() {
  const session = await getSession();
  const mock = isMockMode();
  const [{ rows, minResolved, updatedAt }, tape, counts] = await Promise.all([getLeaderboard(8), getTape(14), getCounts()]);
  // Mock: fixture clock, and everything is labelled "Sample data".
  // Real: data is from our last sync; say how fresh it is (Panta Terms 8).
  const nowSec = displayNowSec();
  const updatedLabel = updatedAt ? `Updated ${ago(updatedAt, nowSec)} ago` : "Waiting for first sync";
  const copy = getSampleCopy(); // illustration only, always labelled "Sample data"

  return (
    <>
      <Tape items={tape} nowSec={nowSec} sample={mock} />

      <div className="mx-auto max-w-[76rem] px-4 sm:px-6">
        {/* Hero: headline + the leaderboard as the centrepiece */}
        <section className="grid gap-6 pb-8 pt-10 sm:pt-14 lg:grid-cols-12 lg:items-end lg:gap-8 lg:pb-10 lg:pt-20">
          <h1 className="animate-rise font-display text-[2.75rem] leading-[2.75rem] tracking-[-0.02em] text-fg sm:text-[4rem] sm:leading-[3.75rem] lg:col-span-7 lg:text-[5.5rem] lg:leading-[5rem]">
            Follow the callers
            <br />
            who are <em className="text-brand-300">right</em>.
          </h1>
          <div className="animate-rise space-y-5 [animation-delay:80ms] lg:col-span-5 lg:pb-1.5">
            <p className="max-w-[28rem] text-base text-fg-muted sm:text-lg sm:leading-7">
              Copycall ranks Panta traders by how often their resolved calls land, pings you when one buys, and lets you
              copy the call after a clear review. Signed by your wallet, every time.
            </p>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
              <WalletButton sessionWallet={session?.w ?? null} size="lg" className="w-full sm:w-auto" />
              <a
                href="#anatomy"
                className="inline-flex h-12 items-center justify-center rounded-[var(--radius-control)] px-4 text-sm font-semibold text-fg-muted transition-colors hover:bg-white/[0.04] hover:text-fg"
              >
                See how a copy works
              </a>
            </div>
          </div>
        </section>

        {/* Stats strip. In mock mode these are fixture counts, labelled like the tape and
            leaderboard (Panta Terms 5: never present simulated data as live). */}
        <section aria-labelledby="stats-title" className="mb-4 sm:mb-6">
          <div className="flex items-center justify-between gap-3 pb-2">
            <h2 id="stats-title" className="label text-fg-subtle">
              Dataset
            </h2>
            {mock ? <Tag>Sample data</Tag> : <p className="label text-fg-subtle">{updatedLabel}</p>}
          </div>
          <dl className="grid grid-cols-3 border-y border-line sm:grid-cols-4">
            {[
              ["Markets", counts.markets],
              ["Callers", counts.callers],
              ["Calls", counts.trades],
              ["Resolved", counts.resolved],
            ].map(([k, v], i) => (
              <div
                key={k}
                className={
                  "flex flex-col gap-0.5 py-3 pr-3 " +
                  (i > 0 ? "border-l border-line pl-3 sm:pl-4 " : "") +
                  (i === 3 ? "hidden sm:flex" : "")
                }
              >
                <dt className="label text-fg-subtle">{k}</dt>
                <dd className="num text-lg text-fg">{v}</dd>
              </div>
            ))}
          </dl>
        </section>

        <div id="leaderboard" className="scroll-mt-20">
          <LeaderboardTable
            rows={rows}
            nowSec={nowSec}
            sample={mock}
            minResolved={minResolved}
            updatedLabel={updatedLabel}
          />
          <p className="mt-3 text-xs text-fg-subtle">
            Hit rate = resolved positions where the side matched the outcome ÷ resolved positions. No profit ranking:
            Panta trade rows carry no price. Stats refresh every 15 minutes; alerts can lag a few minutes.
          </p>
        </div>

        {/* Anatomy of a copy */}
        {copy && (
          <section
            id="anatomy"
            aria-labelledby="anatomy-title"
            className="grid scroll-mt-20 gap-8 border-t border-line py-14 sm:py-20 lg:mt-20 lg:grid-cols-12 lg:gap-8"
          >
            <div className="lg:col-span-5">
              <p className="label text-fg-subtle">Anatomy of a copy</p>
              <h2
                id="anatomy-title"
                className="mt-3 font-display text-[2.25rem] leading-10 tracking-[-0.015em] sm:text-5xl sm:leading-[3rem]"
              >
                Know exactly what
                <br />
                you&apos;re signing.
              </h2>
              <ol className="mt-8 space-y-6">
                {ANATOMY.map((a) => (
                  <li key={a.n} className="grid grid-cols-[1.5rem_1fr] gap-3">
                    <span className="num mt-0.5 flex size-6 items-center justify-center rounded-full border border-brand-500/50 text-[11px] text-brand-300">
                      {a.n}
                    </span>
                    <div>
                      <h3 className="font-semibold tracking-[-0.01em] text-fg">{a.t}</h3>
                      <p className="mt-1 text-sm leading-6 text-fg-muted">{a.d}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
            <div className="lg:col-span-6 lg:col-start-7 lg:pl-8">
              <div className="mx-auto max-w-[26rem]">
                <CopyReview c={copy} nowSec={FIXTURE_NOW} preview />
              </div>
            </div>
          </section>
        )}
      </div>
    </>
  );
}
