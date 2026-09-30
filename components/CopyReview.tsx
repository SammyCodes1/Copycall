import type { ReactNode } from "react";
import { CreatorFlag } from "./CreatorFlag";
import { ago, shortAddr } from "./format";
import { HitRate, SideTag, Tag } from "./ui/Badge";
import { cn } from "./ui/cn";

/** What the review card shows. Quote fields are null while a live quote loads. */
export type CopyReviewData = {
  leader: string;
  leaderHitRate: number | null; // null = not ranked yet
  leaderCalls: number;
  title: string;
  side: "yes" | "no";
  leaderShares: string;
  leaderTime: number | null;
  isCreatorTrade: boolean;
  stakeUsdc: string | null;
  avgPrice: string | null;
  shares: string | null;
  feeUsdc: string | null;
  slippageBps: number | null;
};

function Marker({ n }: { n: string }) {
  return (
    <span
      aria-hidden
      className="num absolute -left-3 top-0 hidden size-6 -translate-x-full items-center justify-center rounded-full border border-brand-500/50 bg-ink-950 text-[11px] text-brand-300 lg:flex"
    >
      {n}
    </span>
  );
}

function Value({ v }: { v: string | null }) {
  if (v !== null) return <>{v}</>;
  return (
    <span className="inline-block h-3.5 w-16 animate-pulse rounded-[3px] bg-white/[0.07] align-middle">
      <span className="sr-only">Loading</span>
    </span>
  );
}

function Row({ k, v, strong, hint }: { k: string; v: string | null; strong?: boolean; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2">
      <dt className="text-sm text-fg-muted">
        {k}
        {hint && <span className="block text-xs text-fg-subtle">{hint}</span>}
      </dt>
      <dd className={cn("num shrink-0 text-right", strong ? "text-base text-fg" : "text-sm text-fg")}>
        <Value v={v} />
      </dd>
    </div>
  );
}

const usdc = (v: string | null) => (v === null ? null : `${v} USDC`);

/**
 * The review-and-sign card. The landing page shows it as a labelled Sample
 * (`preview`, button disabled). /copy/[tradeId] passes the live re-quote and
 * its own `action` (review and sign, signing states, result).
 */
export function CopyReview({
  c,
  nowSec,
  preview,
  badge,
  action,
}: {
  c: CopyReviewData;
  nowSec: number;
  preview?: boolean;
  badge?: ReactNode;
  action?: ReactNode;
}) {
  const pct = c.slippageBps === null ? null : `${(c.slippageBps / 100).toFixed(2)}%`;
  return (
    <article
      aria-label="Copy review"
      className="glass relative rounded-[var(--radius-card)] shadow-[var(--shadow-card)]"
    >
      <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3 sm:px-5">
        <p className="label text-fg-muted">Copy review</p>
        {preview ? <Tag>Sample data</Tag> : badge}
      </header>

      <div className="space-y-5 px-4 py-5 sm:px-5">
        <section className="relative" aria-label="What the leader bought">
          <Marker n="1" />
          <p className="label text-fg-subtle">Leader</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span className="num text-fg" title={c.leader}>
              {shortAddr(c.leader)}
            </span>
            <span className="text-sm text-fg-muted">
              {c.leaderHitRate === null ? (
                "not ranked yet"
              ) : (
                <>
                  <HitRate hitRate={c.leaderHitRate} /> over <span className="num">{c.leaderCalls}</span> calls
                </>
              )}
            </span>
          </div>
          <p className="mt-3 break-words text-[17px] font-semibold leading-6 tracking-[-0.01em] text-fg">{c.title}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <SideTag side={c.side} />
            <span className="num text-sm text-fg-muted">
              bought {c.leaderShares} sh · {ago(c.leaderTime, nowSec)} ago
            </span>
          </div>
          <p className="mt-1 text-sm text-fg-subtle">
            Leader entry price: <span className="text-fg-muted">not available</span>
          </p>
          {c.isCreatorTrade && <CreatorFlag verified={false} className="mt-2.5" />}
        </section>

        <section className="relative border-t border-line pt-4" aria-label="Your copy">
          <Marker n="2" />
          <p className="label text-fg-subtle">Your copy · re-quoted now</p>
          <dl className="mt-1 divide-y divide-line">
            <Row k="You pay" hint="your max stake" v={usdc(c.stakeUsdc)} strong />
            <Row k="Your price" hint="average, from the quote" v={c.avgPrice} />
            <Row k="Est. shares" v={c.shares} />
            <Row k="Fee" v={usdc(c.feeUsdc)} />
            <Row k="Slippage cap" v={pct} />
          </dl>
          <p className="mt-3 rounded-[var(--radius-control)] border border-line bg-white/[0.02] px-3 py-2 text-xs leading-5 text-fg-muted">
            Followers usually buy at a worse price than the leader on the bonding curve. Side and market come from the
            stored trade, never from the link.
          </p>
        </section>

        <section className="relative" aria-label="Sign">
          <Marker n="3" />
          {action ?? (
            <>
              <button
                type="button"
                disabled={preview}
                className="h-12 w-full rounded-[var(--radius-control)] bg-brand-500 text-base font-semibold text-ink-950 shadow-[inset_0_1px_0_rgb(255_255_255/0.28)] transition-colors hover:bg-brand-400 active:translate-y-px disabled:cursor-not-allowed disabled:bg-brand-500/85"
              >
                Review and sign
              </button>
              <p className="mt-2 text-center text-xs text-fg-subtle">
                Preview only. Signing opens your wallet; nothing is sent from here.
              </p>
            </>
          )}
        </section>
      </div>
    </article>
  );
}
