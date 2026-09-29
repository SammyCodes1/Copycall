import { LeaderboardTable } from "@/components/LeaderboardTable";
import { WalletButton } from "@/components/WalletButton";
import { GlassCard } from "@/components/ui/GlassCard";
import { getSession } from "@/lib/auth";
import { getMinResolvedCalls } from "@/lib/env";
import { getLeaderboardPreview } from "@/lib/leaderboard-preview";

// Fixed "now" for the sample data so relative times match the fixtures.
const FIXTURE_NOW = 1790553600;

const STEPS = [
  { t: "Find", d: "Traders ranked by resolved hit rate, not hype." },
  { t: "Follow", d: "Get a Telegram ping when they buy (may lag a few minutes)." },
  { t: "Copy", d: "Review the re-quoted price, then sign with your own wallet." },
];

export default async function Home() {
  const session = await getSession();
  const rows = getLeaderboardPreview(8);
  const minResolved = getMinResolvedCalls();
  const top = rows[0];

  return (
    <div className="mx-auto max-w-6xl px-4 pb-16 sm:px-6">
      <section className="grid gap-10 pb-12 pt-12 sm:pt-20 lg:grid-cols-[1.15fr_0.85fr] lg:items-center lg:gap-14">
        <div className="animate-fade-up">
          <p className="inline-flex items-center gap-2 rounded-[var(--radius-pill)] border border-white/10 bg-white/[0.04] px-3 py-1 text-xs font-semibold text-fg-muted">
            <span aria-hidden className="size-1.5 rounded-full bg-lime-400" />
            Copy trading for Panta prediction markets
          </p>
          <h1 className="mt-5 font-display text-[2.35rem] font-semibold leading-[1.05] tracking-tight text-balance sm:text-6xl">
            Copy the sharpest callers on{" "}
            <span className="bg-[linear-gradient(100deg,#78d02f,#23ad4e_60%)] bg-clip-text text-transparent">
              Panta
            </span>
            , in one tap.
          </h1>
          <p className="mt-5 max-w-xl text-base leading-relaxed text-fg-muted sm:text-lg">
            Follow wallets with a proven hit rate, get pinged when they buy, and mirror the call. Never automatic. Every
            copy is signed by you.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <WalletButton sessionWallet={session?.w ?? null} size="lg" />
            <a
              href="#leaderboard"
              className="inline-flex h-12 items-center rounded-[var(--radius-pill)] px-5 text-sm font-semibold text-fg-muted transition hover:bg-white/5 hover:text-fg"
            >
              See the leaderboard ↓
            </a>
          </div>
        </div>

        {top && (
          <div className="relative">
            <div
              aria-hidden
              className="absolute -inset-6 -z-10 rounded-[2rem] bg-[radial-gradient(closest-side,rgb(35_173_78/0.35),transparent)] blur-2xl"
            />
            <GlassCard className="animate-fade-up p-5 [animation-delay:120ms] sm:p-6">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">Top caller · sample</p>
                <span className="rounded-full bg-brand-500/15 px-2 py-0.5 text-xs font-semibold text-brand-300">
                  #1
                </span>
              </div>
              <p className="mt-4 font-display text-6xl font-semibold tabular-nums tracking-tight text-fg">
                {Math.round(top.hitRate * 100)}
                <span className="text-3xl text-fg-muted">%</span>
              </p>
              <p className="mt-1 text-sm text-fg-muted">hit rate over {top.resolvedCalls} resolved calls</p>
              <div className="mt-5 h-2 overflow-hidden rounded-full bg-white/[0.06]">
                <div
                  className="h-full rounded-full bg-[linear-gradient(90deg,#23ad4e,#78d02f)]"
                  style={{ width: `${Math.round(top.hitRate * 100)}%` }}
                />
              </div>
              <dl className="mt-5 grid grid-cols-3 gap-3 text-center">
                {[
                  ["Correct", top.correctCalls],
                  ["Open", top.openPositions],
                  ["Own-mkt", top.creatorTradeCount],
                ].map(([k, v]) => (
                  <div key={k} className="rounded-2xl bg-white/[0.035] px-2 py-3 ring-1 ring-inset ring-white/[0.06]">
                    <dt className="text-[11px] font-semibold uppercase tracking-wider text-fg-subtle">{k}</dt>
                    <dd className="mt-1 font-display text-xl font-semibold tabular-nums">{v}</dd>
                  </div>
                ))}
              </dl>
            </GlassCard>
          </div>
        )}
      </section>

      <ol className="grid gap-3 pb-12 sm:grid-cols-3">
        {STEPS.map((s, i) => (
          <GlassCard as="li" key={s.t} interactive className="p-5">
            <span className="font-display text-sm font-semibold tabular-nums text-brand-300">0{i + 1}</span>
            <h3 className="mt-2 font-display text-lg font-semibold">{s.t}</h3>
            <p className="mt-1 text-sm leading-relaxed text-fg-muted">{s.d}</p>
          </GlassCard>
        ))}
      </ol>

      <div id="leaderboard" className="scroll-mt-24">
        <LeaderboardTable rows={rows} nowSec={FIXTURE_NOW} sample minResolved={minResolved} />
      </div>
    </div>
  );
}
