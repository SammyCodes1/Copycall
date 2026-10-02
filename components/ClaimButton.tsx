"use client";
/** Claim a resolved win: server builds + checks, wallet signs (simulated in mock), server confirms on chain. */
import { useRouter } from "next/navigation";
import { useState } from "react";
import { FlowError, api, useTxSigner, type Built } from "./tx-client";
import { Button } from "./ui/Button";

type State =
  | { k: "idle" }
  | { k: "building" }
  | { k: "signing" | "confirming"; built: Built }
  | { k: "done"; amount: string; simulated: boolean; warning?: string }
  | { k: "error"; message: string };

export function ClaimButton({
  marketId,
  shares,
  sessionWallet,
  mock,
}: {
  marketId: string;
  shares: string;
  sessionWallet: string;
  mock: boolean;
}) {
  const [state, setState] = useState<State>({ k: "idle" });
  const sign = useTxSigner(sessionWallet, mock);
  const router = useRouter();

  async function claim() {
    setState({ k: "building" });
    try {
      const { data: built } = await api<Built & { winningShares: string }>("POST", "/api/claim/build", { marketId });
      const r = await sign(built, "/api/claim/confirm", (k) => setState({ k, built }));
      // What the checked simulation says arrives (USDC out is negative for a claim), not the share count.
      setState({ k: "done", amount: built.checks.usdcOut.replace(/^-/, ""), simulated: r.simulated, warning: r.warning });
      // Let the confirmation read for a moment, then re-render the row as "Claimed".
      setTimeout(() => router.refresh(), 3000);
    } catch (e) {
      const err = e instanceof FlowError ? e : new FlowError("ERROR", "Something went wrong");
      const prefix = err.code === "TX_REJECTED" || err.code === "TX_FAILED" ? "Transaction rejected. " : "";
      setState({ k: "error", message: prefix + err.message.replace(/^Transaction rejected: /, "") });
    }
  }

  const busy = state.k === "building" || state.k === "signing" || state.k === "confirming";
  const label =
    state.k === "building"
      ? "Checking…"
      : state.k === "signing"
        ? mock
          ? "Simulating…"
          : "Approve in wallet…"
        : state.k === "confirming"
          ? "Confirming…"
          : `Claim ~${shares} USDC`; // about 1 USDC per winning share; the exact amount is checked before signing

  if (state.k === "done") {
    return (
      <p role="status" className="text-sm text-brand-300">
        Claimed <span className="num">{state.amount} USDC</span>
        {state.simulated ? " (simulated)" : ""}
        {state.warning && (
          <span role="alert" className="mt-1 block text-amber-300">
            {state.warning}
          </span>
        )}
      </p>
    );
  }
  return (
    <div className="flex flex-col items-stretch gap-1.5 sm:items-end">
      <Button size="sm" onClick={claim} disabled={busy} aria-describedby={`claim-${marketId}`}>
        {label}
      </Button>
      <p
        id={`claim-${marketId}`}
        role={state.k === "error" ? "alert" : "status"}
        aria-live="polite"
        className="text-xs text-fg-subtle sm:text-right"
      >
        {state.k === "error"
          ? state.message
          : state.k === "signing" || state.k === "confirming"
            ? `Checked: you receive ${state.built.checks.usdcOut.replace(/^-/, "")} USDC, nothing leaves your wallet`
            : mock
              ? "Simulated signing"
              : "Your wallet signs"}
      </p>
    </div>
  );
}
