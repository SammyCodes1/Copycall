import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CreatorFlag } from "@/components/CreatorFlag";
import { StreakTicks } from "@/components/StreakTicks";
import { ago, shortAddr } from "@/components/format";
import { HitRate, SideTag, Tag } from "@/components/ui/Badge";
import { isMockMode } from "@/lib/env";
import { displayNowSec, getTraderProfile } from "@/lib/queries";
import { PubkeySchema } from "@/lib/schemas";

export async function generateMetadata({ params }: PageProps<"/trader/[wallet]">): Promise<Metadata> {
  const { wallet } = await params;
  const ok = PubkeySchema.safeParse(wallet).success;
  return { title: ok ? `Trader ${shortAddr(wallet)} · Copycall` : "Trader · Copycall" };
}

const PHASE_LABEL = { primary: "Primary", secondary: "Secondary", resolved: "Resolved", cancelled: "Cancelled" } as const;

/** /trader/[wallet]: stats, recent calls and open positions, all from our own store. */
export default async function TraderPage({ params }: PageProps<"/trader/[wallet]">) {
  const { wallet: raw } = await params;
  const parsed = PubkeySchema.safeParse(raw);
  if (!parsed.success) notFound();
  const wallet = parsed.data;

  const mock = isMockMode();
  const nowSec = displayNowSec();
  const p = await getTraderProfile(wallet);
  const s = p?.stats ?? null;

  return (
    <div className="mx-auto max-w-[76rem] px-4 pb-16 sm:px-6">
      <nav aria-label="Breadcrumb" className="pt-6">
        <Link href="/#leaderboard" className="label text-fg-muted hover:text-fg">
          ← Leaderboard
        </Link>
      </nav>

      <header className="animate-rise pb-6 pt-5 sm:pt-8">
        <div className="flex flex-wrap items-center gap-2">
          <p className="label text-fg-subtle">Trader</p>
          {s && s.rank > 0 && <Tag tone="yes">Rank #{s.rank}</Tag>}
          {s && s.rank === 0 && <Tag>Not ranked</Tag>}
          {mock && <Tag>Sample data</Tag>}
        </div>
        <h1 className="mt-3 font-display text-[2.5rem] leading-[2.75rem] tracking-[-0.015em] sm:text-6xl sm:leading-[4rem]">
          {shortAddr(wallet)}
        </h1>
        <p className="num mt-2 break-all text-xs text-fg-subtle sm:text-sm">{wallet}</p>
        {s && s.creatorTradeCount > 0 && (
          <CreatorFlag count={s.creatorTradeCount} verified={s.creatorVerified} className="mt-3" />
        )}
      </header>

      {!p ? (
        <section className="card px-5 py-12 text-center sm:px-8">
          <h2 className="font-display text-3xl">No trades yet</h2>
          <p className="mx-auto mt-2 max-w-[32rem] text-sm leading-6 text-fg-muted">
            We haven&apos;t seen this wallet trade on Panta. Wallets appear after the leaderboard sync picks up one of
            their trades.
          </p>
        </section>
      ) : (
        <>
          {/* Stats strip */}
          <section aria-labelledby="stats-title">
            <h2 id="stats-title" className="sr-only">
              Stats
            </h2>
            <dl className="grid grid-cols-2 border-y border-line sm:grid-cols-5">
              <div className="col-span-2 flex flex-col gap-1 py-4 pr-4 sm:col-span-1">
                <dt className="label text-fg-subtle">Hit rate</dt>
                <dd className="text-4xl leading-10">
                  {s && s.resolvedCalls > 0 ? <HitRate hitRate={s.hitRate} /> : <span className="num text-fg-subtle">—</span>}
                </dd>
              </div>
              {[
                ["Record", s ? `${s.correctCalls}–${s.resolvedCalls - s.correctCalls}` : "—"],
                ["Resolved", s ? String(s.resolvedCalls) : "0"],
                ["Open", s ? String(s.openPositions) : "0"],
                ["Last active", s ? ago(s.lastActive, nowSec) : "—"],
              ].map(([k, v], i) => (
                <div
                  key={k}
                  className={
                    "flex flex-col gap-1 border-t border-line py-4 pr-3 sm:border-t-0 sm:border-l sm:pl-4 " +
                    (i % 2 === 1 ? "border-l pl-3" : "")
                  }
                >
                  <dt className="label text-fg-subtle">{k}</dt>
                  <dd className="num text-xl text-fg">{v}</dd>
                </div>
              ))}
            </dl>
            <div className="flex flex-wrap items-center justify-between gap-3 py-4">
              <div className="flex items-center gap-3">
                {s && s.streak.length > 0 && <StreakTicks results={s.streak} />}
                <span className="text-xs text-fg-subtle">
                  {s && s.rank === 0
                    ? `Needs ${p.minResolved} resolved calls to be ranked (has ${s.resolvedCalls}).`
                    : "Last resolved calls, oldest to newest."}
                </span>
              </div>
            </div>
          </section>

          <div className="mt-4 grid gap-6 lg:grid-cols-12">
            <section aria-labelledby="calls-title" className="card overflow-hidden lg:col-span-7">
              <div className="flex items-end justify-between gap-3 border-b border-line px-4 pb-3 pt-4 sm:px-5">
                <h2 id="calls-title" className="font-display text-2xl">
                  Recent calls
                </h2>
                <span className="label text-fg-subtle">{p.trades.length} shown</span>
              </div>
              {p.trades.length === 0 ? (
                <p className="px-5 py-10 text-center text-sm text-fg-muted">No trades yet.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {p.trades.map((t) => (
                    <li key={t.id} className="grid grid-cols-[auto_1fr_auto] items-start gap-x-3 px-4 py-3 sm:px-5">
                      <SideTag side={t.side} className="mt-0.5" />
                      <div className="min-w-0">
                        <p className="text-sm leading-5 text-fg">{t.title}</p>
                        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="num text-xs text-fg-muted">{t.shares} shares</span>
                          <span className="label text-fg-subtle">{t.isPrimary ? "Primary" : "Secondary"}</span>
                          {t.isCreatorTrade && <CreatorFlag verified={t.creatorVerified} />}
                        </div>
                      </div>
                      <span className="num text-xs text-fg-subtle">{ago(t.blockTime, nowSec)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section aria-labelledby="open-title" className="card self-start overflow-hidden lg:col-span-5">
              <div className="flex items-end justify-between gap-3 border-b border-line px-4 pb-3 pt-4 sm:px-5">
                <h2 id="open-title" className="font-display text-2xl">
                  Open positions
                </h2>
                <span className="label text-fg-subtle">{p.openPositions.length}</span>
              </div>
              {p.openPositions.length === 0 ? (
                <p className="px-5 py-10 text-center text-sm text-fg-muted">No open positions.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {p.openPositions.map((o) => (
                    <li key={o.marketId + o.side} className="grid grid-cols-[auto_1fr] gap-x-3 px-4 py-3 sm:px-5">
                      <SideTag side={o.side} className="mt-0.5" />
                      <div className="min-w-0">
                        <p className="text-sm leading-5 text-fg">{o.title}</p>
                        <p className="mt-1 flex gap-2">
                          <span className="num text-xs text-fg-muted">{o.shares} shares</span>
                          <span className="label text-fg-subtle">{PHASE_LABEL[o.phase]}</span>
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
          <p className="mt-4 text-xs text-fg-subtle">
            {mock
              ? "Sample data from fixtures."
              : p.updatedAt
                ? `Stats updated ${ago(p.updatedAt, nowSec)} ago from Panta positions.`
                : "Stats appear after the next sync."}{" "}
            Leader entry prices aren&apos;t available: Panta trade rows carry no price.
          </p>
        </>
      )}
    </div>
  );
}
