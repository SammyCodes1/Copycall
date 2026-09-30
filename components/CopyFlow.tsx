"use client";
/**
 * Live copy screen: re-quote -> Review and sign -> server builds + checks ->
 * wallet signs the exact bytes (simulated in mock mode) -> server confirms on
 * chain -> recorded. Every state is shown honestly.
 */
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { totalWithFeeText } from "@/lib/copy-math";
import { CopyReview, reviewAmounts, type CopyReviewData } from "./CopyReview";
import { shortAddr } from "./format";
import { FlowError, api, useTxSigner, type Built, type Confirmed } from "./tx-client";
import { Tag } from "./ui/Badge";
import { Button, buttonClasses } from "./ui/Button";
import { cn } from "./ui/cn";

type Quote = {
  quoteToken: string;
  amountUsdc: string;
  shares: string;
  avgPrice: string;
  feeUsdc: string;
  maxUsdcOut: string; // the guard's limit: the max stake, fee included
  slippageBps: number;
  validUntil: number;
};

type Phase =
  | { k: "quoting" }
  | { k: "review" }
  | { k: "building" }
  | { k: "signing"; built: Built }
  | { k: "confirming"; built: Built }
  | { k: "done"; built: Built; result: Confirmed }
  | { k: "error"; code: string; message: string; built?: Built };

export type CopyFlowProps = {
  tradeId: string;
  base: Omit<CopyReviewData, "stakeUsdc" | "avgPrice" | "shares" | "feeUsdc" | "slippageBps">;
  nowSec: number;
  mock: boolean;
  sessionWallet: string;
  closed: boolean;
};

function Spinner() {
  return (
    <span
      aria-hidden
      className="inline-block size-4 animate-spin rounded-full border-2 border-current border-r-transparent align-[-2px]"
    />
  );
}

function Check({ ok, children }: { ok: boolean | null; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2.5 py-1.5 text-sm">
      <span
        aria-hidden
        className={cn(
          "mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-full border text-[10px]",
          ok ? "border-brand-500/60 bg-brand-500/15 text-brand-300" : "border-line-strong text-fg-subtle",
        )}
      >
        {ok ? "✓" : ""}
      </span>
      <span className="min-w-0 text-fg-muted">{children}</span>
    </li>
  );
}

/** "Checked before signing": what the server verified about the exact transaction. */
function Checks({ built }: { built: Built }) {
  const c = built.checks;
  return (
    <div className="rounded-[var(--radius-control)] border border-line bg-white/[0.02] px-3 py-2">
      <p className="label pt-1 text-fg-subtle">Checked before signing</p>
      <ul className="mt-1">
        <Check ok>
          Fee payer and only signer: <span className="num text-fg">{shortAddr(c.feePayer)}</span> (you)
        </Check>
        <Check ok>
          Programs: <span className="text-fg">{c.programs.join(", ")}</span>, all allowlisted
        </Check>
        <Check ok>
          Simulated: <span className="num text-fg">{c.usdcOut} USDC</span> leaves your wallet, fee included (limit{" "}
          <span className="num">{c.maxUsdcOut}</span>, your max stake)
        </Check>
        <Check ok>No approvals, no authority changes; your other token accounts are unchanged</Check>
      </ul>
    </div>
  );
}

export function CopyFlow({ tradeId, base, nowSec, mock, sessionWallet, closed }: CopyFlowProps) {
  const [quote, setQuote] = useState<Quote | null>(null);
  const [phase, setPhase] = useState<Phase>(
    closed
      ? { k: "error", code: "MARKET_CLOSED", message: "This market isn't taking new buys any more." }
      : { k: "quoting" },
  );
  const [left, setLeft] = useState<number | null>(null);
  const sign = useTxSigner(sessionWallet, mock);
  const statusRef = useRef<HTMLDivElement>(null);

  const loadQuote = useCallback(async () => {
    setPhase({ k: "quoting" });
    try {
      const { data } = await api<Quote>("GET", `/api/copy/${tradeId}/quote`);
      setQuote(data);
      setPhase({ k: "review" });
    } catch (e) {
      const err = e instanceof FlowError ? e : new FlowError("ERROR", "Couldn't get a quote");
      setPhase({ k: "error", code: err.code, message: err.message });
    }
  }, [tradeId]);

  useEffect(() => {
    if (closed) return;
    const t = setTimeout(loadQuote, 0);
    return () => clearTimeout(t);
  }, [closed, loadQuote]);

  // Quote countdown; an expired quote can't be signed.
  useEffect(() => {
    if (!quote || phase.k !== "review") return;
    const tick = () => {
      const s = Math.max(0, quote.validUntil - Math.floor(Date.now() / 1000));
      setLeft(s);
      if (s === 0) setPhase({ k: "error", code: "QUOTE_EXPIRED", message: "Quote expired, refresh." });
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [quote, phase.k]);

  useEffect(() => {
    if (phase.k !== "review" && phase.k !== "quoting") statusRef.current?.focus();
  }, [phase.k]);

  async function reviewAndSign() {
    if (!quote) return;
    setPhase({ k: "building" });
    let built: Built | undefined;
    try {
      ({ data: built } = await api<Built>("POST", `/api/copy/${tradeId}/build`, { quoteToken: quote.quoteToken }));
      const b = built;
      const result = await sign(b, "/api/copy/confirm", (s) => setPhase({ k: s, built: b }));
      setPhase({ k: "done", built: b, result });
    } catch (e) {
      const err = e instanceof FlowError ? e : new FlowError("ERROR", "Something went wrong");
      setPhase({ k: "error", code: err.code, message: err.message, built });
    }
  }

  const data: CopyReviewData = {
    ...base,
    stakeUsdc: quote?.amountUsdc ?? null,
    avgPrice: quote?.avgPrice ?? null,
    shares: quote?.shares ?? null,
    feeUsdc: quote?.feeUsdc ?? null,
    slippageBps: quote?.slippageBps ?? null,
  };

  const amounts = reviewAmounts(data);
  const totalText = amounts ? totalWithFeeText(amounts.total, amounts.fee) : null;

  const badge =
    phase.k === "done" ? (
      <Tag tone="yes">Copied</Tag>
    ) : mock ? (
      <Tag tone="amber">Simulated signing</Tag>
    ) : left !== null && phase.k === "review" ? (
      <span className="num text-xs text-fg-subtle" aria-live="off">
        quote valid {left}s
      </span>
    ) : null;

  return <CopyReview c={data} nowSec={nowSec} badge={badge} action={renderAction()} />;

  function renderAction() {
    const status = (text: string) => (
      <div
        ref={statusRef}
        tabIndex={-1}
        role="status"
        aria-live="polite"
        className="flex items-center justify-center gap-2 py-3 text-sm text-fg outline-none"
      >
        <Spinner />
        {text}
      </div>
    );

    switch (phase.k) {
      case "quoting":
        return (
          <>
            <Button size="lg" className="w-full" disabled>
              <Spinner /> Getting a fresh quote…
            </Button>
            <p className="mt-2 text-center text-xs text-fg-subtle">
              Re-quoting with your saved max stake and slippage.
            </p>
          </>
        );
      case "review":
        return (
          <>
            <p className="mb-3 text-sm leading-6 text-fg-muted">
              Next, Copycall builds this exact order and checks it. Then your wallet asks you to approve{" "}
              <span className="num text-fg">{totalText}</span>. Any transaction that would move more than{" "}
              <span className="num text-fg">{quote?.maxUsdcOut} USDC</span> is refused. Copycall never holds your
              funds.
            </p>
            <Button size="lg" className="w-full" onClick={reviewAndSign} disabled={!amounts}>
              Review and sign
            </Button>
            <p className="mt-2 text-center text-xs text-fg-subtle">
              {mock
                ? "Mock mode: signing is simulated. No wallet prompt, nothing is sent."
                : "Your wallet will show the transaction before anything is sent."}
            </p>
          </>
        );
      case "building":
        return status("Checking the transaction…");
      case "signing":
        return (
          <div className="space-y-3">
            <Checks built={phase.built} />
            {status(mock ? "Simulating your signature…" : "Approve in your wallet…")}
          </div>
        );
      case "confirming":
        return (
          <div className="space-y-3">
            <Checks built={phase.built} />
            {status("Confirming on Solana…")}
          </div>
        );
      case "done":
        return (
          <div ref={statusRef} tabIndex={-1} role="status" className="space-y-3 outline-none">
            <div className="rounded-[var(--radius-control)] border border-brand-500/40 bg-brand-500/[0.07] px-4 py-4">
              <p className="text-base font-semibold text-fg">Copy recorded</p>
              <p className="mt-1 text-sm leading-6 text-fg-muted">
                You bought {base.side === "yes" ? "YES" : "NO"} for{" "}
                <span className="num text-fg">{totalText}</span>. Confirmed on{" "}
                {phase.result.simulated ? "the mock chain" : "Solana"}
                {phase.result.reported ? " and reported to Panta." : ". Panta attribution will be retried."}
              </p>
              <p className="num mt-2 break-all text-xs text-fg-subtle">
                {phase.result.simulated ? "Simulated signature " : "Signature "}
                {phase.result.signature}
              </p>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Link href="/positions" className={buttonClasses("primary", "lg", "w-full sm:flex-1")}>
                View positions
              </Link>
              <Link href="/#leaderboard" className={buttonClasses("secondary", "lg", "w-full sm:flex-1")}>
                Back to leaderboard
              </Link>
            </div>
          </div>
        );
      case "error": {
        const expired = phase.code === "QUOTE_EXPIRED";
        const rejectedTx = phase.code === "TX_REJECTED" || phase.code === "TX_FAILED";
        const title = expired
          ? "Quote expired, refresh"
          : rejectedTx
            ? "Transaction rejected"
            : phase.code === "WALLET_DECLINED"
              ? "Not signed"
              : phase.code === "MARKET_CLOSED"
                ? "Market closed"
                : "Couldn't continue";
        const canRetry = phase.code !== "MARKET_CLOSED" && phase.code !== "TRADE_NOT_FOUND";
        return (
          <div ref={statusRef} tabIndex={-1} role="alert" className="space-y-3 outline-none">
            <div className="rounded-[var(--radius-control)] border border-coral-400/35 bg-coral-400/[0.06] px-4 py-3">
              <p className="font-semibold text-fg">{title}</p>
              <p className="mt-1 text-sm leading-6 text-fg-muted">{phase.message}</p>
            </div>
            {canRetry && (
              <Button size="lg" variant={expired ? "primary" : "secondary"} className="w-full" onClick={loadQuote}>
                {expired ? "Refresh quote" : "Start again"}
              </Button>
            )}
            {phase.code === "AMOUNT_TOO_SMALL" || phase.code === "SLIPPAGE_TOO_HIGH" ? (
              <Link href="/settings" className={buttonClasses("ghost", "md", "w-full")}>
                Open settings
              </Link>
            ) : null}
          </div>
        );
      }
    }
  }
}
