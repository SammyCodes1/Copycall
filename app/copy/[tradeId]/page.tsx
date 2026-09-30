import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CopyFlow } from "@/components/CopyFlow";
import { WalletButton } from "@/components/WalletButton";
import { buttonClasses } from "@/components/ui/Button";
import { getSession } from "@/lib/auth";
import { loadCopyContext } from "@/lib/copy-core";
import { ensureMockData, getUserDeps } from "@/lib/data";
import { getMinResolvedCalls, isMockMode } from "@/lib/env";
import { displayNowSec } from "@/lib/queries";
import { safeTitle } from "@/lib/text";

export const metadata: Metadata = { title: "Copy a trade · Copycall", robots: { index: false } };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-[36rem] px-4 pb-16 sm:px-6">
      <header className="animate-rise pb-6 pt-10 sm:pt-14">
        <p className="label text-fg-subtle">Copy a trade</p>
        <h1 className="mt-3 font-display text-[2.5rem] leading-[2.75rem] tracking-[-0.015em] sm:text-5xl sm:leading-[3.25rem]">
          Review, then sign
        </h1>
        <p className="mt-3 text-fg-muted">
          Exactly what will happen, before anything is sent. Your wallet signs; Copycall never holds your funds.
        </p>
      </header>
      {children}
    </div>
  );
}

/**
 * /copy/[tradeId]: the link carries only our internal trade id (uuid).
 * Login required. Side and market come from the stored trade; amount and
 * slippage from the user's saved settings.
 */
export default async function CopyPage({ params }: PageProps<"/copy/[tradeId]">) {
  const { tradeId } = await params;
  if (!UUID.test(tradeId)) notFound();

  const session = await getSession();
  if (!session) {
    return (
      <Shell>
        <section className="card px-5 py-8 sm:px-8">
          <h2 className="text-lg font-semibold">Sign in to copy this trade</h2>
          <p className="mt-2 text-sm leading-6 text-fg-muted">
            Connect the wallet you&apos;ll copy with and sign a one-time message. No transaction, no fees. The copy is
            re-quoted with your own max stake and slippage.
          </p>
          <WalletButton sessionWallet={null} size="lg" className="mt-6 w-full sm:w-auto" />
        </section>
      </Shell>
    );
  }

  await ensureMockData();
  const deps = getUserDeps();
  const ctx = await loadCopyContext(deps, tradeId);
  if (!ctx) {
    return (
      <Shell>
        <section className="card px-5 py-8 text-center sm:px-8">
          <h2 className="text-lg font-semibold">No trade to copy here</h2>
          <p className="mt-2 text-sm leading-6 text-fg-muted">
            This link doesn&apos;t match a buy we&apos;ve seen. It may be old or mistyped.
          </p>
          <Link href="/#leaderboard" className={buttonClasses("secondary", "lg", "mt-6 w-full sm:w-auto")}>
            Back to leaderboard
          </Link>
        </section>
      </Shell>
    );
  }

  const { trade, market } = ctx;
  const stats = await deps.data.getTraderStats(trade.wallet);
  const ranked = !!stats && stats.resolvedCalls >= getMinResolvedCalls();

  return (
    <Shell>
      <CopyFlow
        tradeId={trade.id}
        nowSec={displayNowSec()}
        mock={isMockMode()}
        sessionWallet={session.w}
        closed={!!market && market.status !== "primary"}
        base={{
          leader: trade.wallet,
          leaderHitRate: ranked ? stats!.hitRate : null,
          leaderCalls: stats?.resolvedCalls ?? 0,
          title: safeTitle(market?.title ?? "Untitled market"),
          side: trade.side === "YES" ? "yes" : "no",
          leaderShares: trade.shares,
          leaderTime: trade.blockTime,
          isCreatorTrade: trade.isCreatorTrade,
        }}
      />
      <p className="mt-4 text-center text-xs leading-5 text-fg-subtle">
        Want a different amount? Change your max stake in{" "}
        <Link href="/settings" className="text-fg-muted underline underline-offset-4">
          Settings
        </Link>
        . Alerts can lag a few minutes, so the price may have moved.
      </p>
    </Shell>
  );
}
