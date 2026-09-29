import type { ReactNode } from "react";
import type { SampleCopy } from "@/lib/leaderboard-preview";
import { CreatorFlag } from "./CreatorFlag";
import { ago, shortAddr } from "./format";
import { HitRate, SideTag, Tag } from "./ui/Badge";
import { cn } from "./ui/cn";

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

function Row({ k, v, strong }: { k: string; v: ReactNode; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2">
      <dt className="text-sm text-fg-muted">{k}</dt>
      <dd className={cn("num text-right", strong ? "text-base text-fg" : "text-sm text-fg")}>{v}</dd>
    </div>
  );
}

/**
 * The review-and-sign card. In batch 1 it renders a preview from fixtures
 * (`preview` = true: sign button disabled, labelled Sample). Batch 2 feeds it
 * a real server-side re-quote.
 */
export function CopyReview({ c, nowSec, preview }: { c: SampleCopy; nowSec: number; preview?: boolean }) {
  return (
    <article
      aria-label="Copy review"
      className="glass relative rounded-[var(--radius-card)] shadow-[var(--shadow-card)]"
    >
      <header className="flex items-center justify-between border-b border-line px-5 py-3">
        <p className="label text-fg-muted">Copy review</p>
        {preview && <Tag>Sample data</Tag>}
      </header>

      <div className="space-y-5 px-5 py-5">
        <section className="relative">
          <Marker n="1" />
          <p className="label text-fg-subtle">Leader</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span className="num text-fg">{shortAddr(c.leader)}</span>
            <span className="text-sm text-fg-muted">
              <HitRate hitRate={c.leaderHitRate} /> over <span className="num">{c.leaderCalls}</span> calls
            </span>
          </div>
          <p className="mt-3 text-[17px] font-semibold leading-6 tracking-[-0.01em] text-fg">{c.title}</p>
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

        <section className="relative border-t border-line pt-4">
          <Marker n="2" />
          <p className="label text-fg-subtle">Your copy · re-quoted now</p>
          <dl className="mt-1 divide-y divide-line">
            <Row k="You pay (max stake)" v={`${c.stakeUsdc} USDC`} strong />
            <Row k="Est. avg price" v={c.avgPrice} />
            <Row k="Est. shares" v={c.shares} />
            <Row k="Fee" v={`${c.feeUsdc} USDC`} />
            <Row k="Slippage cap" v={`${(c.slippageBps / 100).toFixed(2)}%`} />
          </dl>
          <p className="mt-3 rounded-[var(--radius-control)] border border-line bg-white/[0.02] px-3 py-2 text-xs leading-5 text-fg-muted">
            Followers usually fill at a worse price than the leader on the bonding curve. Side and market come from the
            stored trade, never from the link.
          </p>
        </section>

        <section className="relative">
          <Marker n="3" />
          <button
            type="button"
            disabled={preview}
            className="h-12 w-full rounded-[var(--radius-control)] bg-brand-500 text-base font-semibold text-ink-950 shadow-[inset_0_1px_0_rgb(255_255_255/0.28)] transition-colors hover:bg-brand-400 active:translate-y-px disabled:cursor-not-allowed disabled:bg-brand-500/85"
          >
            Review and sign
          </button>
          <p className="mt-2 text-center text-xs text-fg-subtle">
            {preview
              ? "Preview only. Signing opens your wallet; nothing is sent from here."
              : "Your wallet will ask you to approve."}
          </p>
        </section>
      </div>
    </article>
  );
}
