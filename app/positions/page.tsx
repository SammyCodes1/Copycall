import type { Metadata } from "next";
import Link from "next/link";
import { ClaimButton } from "@/components/ClaimButton";
import { WalletButton } from "@/components/WalletButton";
import { ago, shortAddr } from "@/components/format";
import { SideTag, Tag } from "@/components/ui/Badge";
import { getSession } from "@/lib/auth";
import { totalWithFeeShort } from "@/lib/copy-math";
import { positionsForSession, type PositionView, type PositionsView } from "@/lib/copy-core";
import { ensureMockData } from "@/lib/data";
import { isMockMode } from "@/lib/env";
import { getFlowDeps } from "@/lib/flow";
import { displayNowSec } from "@/lib/queries";

export const metadata: Metadata = { title: "Positions · Copycall" };

const STATUS: Record<PositionView["status"], { label: string; tone: "yes" | "no" | "neutral" | "amber" }> = {
  claimable: { label: "Won · claimable", tone: "yes" },
  won: { label: "Won", tone: "yes" },
  open: { label: "Open", tone: "neutral" },
  claimed: { label: "Claimed", tone: "neutral" },
  lost: { label: "Lost", tone: "no" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

/** /positions: the signed-in wallet's Panta positions, claims, and recorded copies. */
export default async function PositionsPage() {
  const session = await getSession();
  if (!session) {
    return (
      <div className="mx-auto max-w-[40rem] px-4 pb-16 pt-12 sm:px-6 sm:pt-20">
        <h1 className="font-display text-[2.75rem] leading-[3rem] tracking-[-0.015em]">Positions</h1>
        <section className="card mt-6 px-5 py-8 sm:px-8">
          <h2 className="text-lg font-semibold">Sign in to see your positions</h2>
          <p className="mt-2 text-sm leading-6 text-fg-muted">
            Connect your wallet and sign a one-time message. No transaction, no fees.
          </p>
          <WalletButton sessionWallet={null} size="lg" className="mt-6 w-full sm:w-auto" />
        </section>
      </div>
    );
  }

  await ensureMockData();
  const mock = isMockMode();
  let view: PositionsView | null = null;
  let error: string | null = null;
  try {
    view = await positionsForSession(getFlowDeps(), session);
  } catch (e) {
    error = e instanceof Error && "code" in e ? e.message : "Couldn't load positions right now.";
  }
  const nowSec = displayNowSec();

  return (
    <div className="mx-auto max-w-[48rem] px-4 pb-16 sm:px-6">
      <header className="animate-rise pb-6 pt-10 sm:pt-14">
        <div className="flex flex-wrap items-center gap-2">
          <p className="label text-fg-subtle">Wallet {shortAddr(session.w)}</p>
          {mock && <Tag tone="amber">Simulated</Tag>}
        </div>
        <h1 className="mt-3 font-display text-[2.75rem] leading-[3rem] tracking-[-0.015em] sm:text-6xl sm:leading-[4rem]">
          Positions
        </h1>
        <p className="mt-3 max-w-[34rem] text-fg-muted">
          There&apos;s no selling on Panta: positions pay out by claiming after the market resolves. A winning share
          claims about 1 USDC.
        </p>
      </header>

      {error && (
        <p role="alert" className="card px-5 py-6 text-sm text-coral-400">
          {error}
        </p>
      )}

      {view && (
        <>
          <section aria-labelledby="holdings-title" className="card overflow-hidden">
            <div className="flex items-end justify-between gap-3 border-b border-line px-4 pb-3 pt-5 sm:px-6">
              <h2 id="holdings-title" className="font-display text-2xl">
                Holdings
              </h2>
              <span className="label text-fg-subtle">{view.positions.length}</span>
            </div>
            {view.positions.length === 0 ? (
              <p className="px-6 py-10 text-center text-sm text-fg-muted">
                No positions yet.{" "}
                <Link href="/#leaderboard" className="text-brand-300 underline underline-offset-4">
                  Find a trader to copy
                </Link>
                .
              </p>
            ) : (
              <ul className="divide-y divide-line">
                {view.positions.map((p) => (
                  <li
                    key={`${p.marketId}-${p.side}`}
                    className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6"
                  >
                    <div className="min-w-0">
                      <p className="break-words font-semibold leading-6 text-fg">{p.title}</p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-2">
                        <SideTag side={p.side === "YES" ? "yes" : "no"} />
                        <span className="num text-sm text-fg-muted">{p.shares} sh</span>
                        <Tag tone={STATUS[p.status].tone}>{STATUS[p.status].label}</Tag>
                      </div>
                    </div>
                    {p.status === "claimable" && (
                      <ClaimButton marketId={p.marketId} shares={p.shares} sessionWallet={session.w} mock={mock} />
                    )}
                  </li>
                ))}
              </ul>
            )}
            <p className="border-t border-line px-4 py-3 text-xs text-fg-subtle sm:px-6">
              From Panta&apos;s positions index, which can lag the chain briefly after a buy.
            </p>
          </section>

          <section aria-labelledby="copies-title" className="card mt-6 overflow-hidden">
            <div className="flex items-end justify-between gap-3 border-b border-line px-4 pb-3 pt-5 sm:px-6">
              <h2 id="copies-title" className="font-display text-2xl">
                Your copies
              </h2>
              <span className="label text-fg-subtle">{view.copies.length}</span>
            </div>
            {view.copies.length === 0 ? (
              <p className="px-6 py-10 text-center text-sm text-fg-muted">No copies yet.</p>
            ) : (
              <ul className="divide-y divide-line">
                {view.copies.map((c) => (
                  <li key={c.id} className="px-4 py-3 sm:px-6">
                    <p className="break-words text-sm font-semibold text-fg">{c.title}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-fg-muted">
                      <SideTag side={c.side === "YES" ? "yes" : "no"} />
                      <span className="num">
                        {totalWithFeeShort(c.amountUsdc, c.feeUsdc)}
                      </span>
                      <span className="num">{c.shares} sh</span>
                      <span className="num text-fg-subtle">{ago(c.createdAt, nowSec)} ago</span>
                      <span className="num text-xs text-fg-subtle" title={c.signature}>
                        {mock ? "sim " : "sig "}
                        {shortAddr(c.signature)}
                      </span>
                      {!c.reported && <Tag tone="amber">Attribution pending</Tag>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
