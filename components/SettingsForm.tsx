"use client";
/**
 * Copy limits + alerts toggle (PUT /api/settings). The server validates again
 * and enforces the 5% slippage cap; the client limits are only for convenience.
 */
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { sendJson } from "./api";
import { Button } from "./ui/Button";
import { cn } from "./ui/cn";

type Settings = { maxStakeUsdc: string; slippageBps: number; alertsEnabled: boolean };

const field =
  "num h-11 w-full rounded-[var(--radius-control)] border border-control bg-ink-950/60 px-3 text-base text-fg " +
  "placeholder:text-fg-subtle focus-visible:border-brand-300 focus-visible:outline-none aria-[invalid=true]:border-coral-400";

/** capUsdc: the server's launch cap per copy (MAX_STAKE_USDC); null = copying not configured. */
export function SettingsForm({ initial, capUsdc }: { initial: Settings; capUsdc: string | null }) {
  const router = useRouter();
  const id = useId();
  const [stake, setStake] = useState(initial.maxStakeUsdc);
  const [slippagePct, setSlippagePct] = useState((initial.slippageBps / 100).toFixed(1));
  const [alerts, setAlerts] = useState(initial.alertsEnabled);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const pct = Number(slippagePct);
  const slippageInvalid = !(slippagePct.trim() !== "" && Number.isFinite(pct) && pct >= 0 && pct <= 5);
  const stakeNum = Number(stake);
  const maxStake = capUsdc !== null ? Math.min(1000, Number(capUsdc)) : 1000;
  const stakeInvalid = !(/^\d{1,4}(\.\d{1,2})?$/.test(stake.trim()) && stakeNum >= 1 && stakeNum <= maxStake);

  function save(e: React.FormEvent) {
    e.preventDefault();
    setStatus(null);
    if (stakeInvalid || slippageInvalid) {
      setStatus({ ok: false, text: "Check the highlighted fields." });
      return;
    }
    startTransition(async () => {
      try {
        const saved = await sendJson<Settings>("PUT", "/api/settings", {
          maxStakeUsdc: stake.trim(),
          slippageBps: Math.round(pct * 100),
          alertsEnabled: alerts,
        });
        setStake(saved.maxStakeUsdc);
        setSlippagePct((saved.slippageBps / 100).toFixed(1));
        setAlerts(saved.alertsEnabled);
        setStatus({ ok: true, text: "Saved." });
        router.refresh();
      } catch (err) {
        setStatus({ ok: false, text: err instanceof Error ? err.message : "Couldn't save" });
      }
    });
  }

  return (
    <form onSubmit={save} noValidate className="space-y-6">
      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label htmlFor={`${id}-stake`} className="label text-fg-muted">
            Max stake per copy
          </label>
          <div className="relative mt-2">
            <input
              id={`${id}-stake`}
              inputMode="decimal"
              autoComplete="off"
              value={stake}
              onChange={(e) => setStake(e.target.value)}
              aria-invalid={stakeInvalid}
              aria-describedby={`${id}-stake-help`}
              className={cn(field, "pr-16")}
            />
            <span className="label pointer-events-none absolute inset-y-0 right-3 flex items-center text-fg-subtle">
              USDC
            </span>
          </div>
          <p id={`${id}-stake-help`} className="mt-1.5 text-xs leading-5 text-fg-subtle">
            {capUsdc !== null
              ? `1–${capUsdc} USDC (this server's limit per copy). Every copy is capped at this, whatever the leader bought.`
              : "1–1000 USDC. Every copy is capped at this, whatever the leader bought."}
          </p>
        </div>
        <div>
          <label htmlFor={`${id}-slip`} className="label text-fg-muted">
            Slippage cap
          </label>
          <div className="relative mt-2">
            <input
              id={`${id}-slip`}
              inputMode="decimal"
              autoComplete="off"
              value={slippagePct}
              onChange={(e) => setSlippagePct(e.target.value)}
              aria-invalid={slippageInvalid}
              aria-describedby={`${id}-slip-help`}
              className={cn(field, "pr-10")}
            />
            <span className="label pointer-events-none absolute inset-y-0 right-3 flex items-center text-fg-subtle">
              %
            </span>
          </div>
          <p id={`${id}-slip-help`} className="mt-1.5 text-xs leading-5 text-fg-subtle">
            Default 2%. Hard maximum 5%, enforced by the server.
          </p>
        </div>
      </div>

      <div className="flex items-start justify-between gap-4 border-t border-line pt-5">
        <div>
          <p id={`${id}-alerts`} className="font-semibold text-fg">
            Copy alerts
          </p>
          <p className="mt-1 text-sm leading-5 text-fg-muted">
            A Telegram message when a trader you follow buys. Alerts can lag a few minutes.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={alerts}
          aria-labelledby={`${id}-alerts`}
          onClick={() => setAlerts((a) => !a)}
          className={cn(
            "relative mt-0.5 inline-flex h-7 w-12 shrink-0 items-center rounded-full border transition-colors",
            alerts ? "border-brand-500 bg-brand-500" : "border-control bg-ink-950",
          )}
        >
          <span
            aria-hidden
            className={cn(
              "absolute size-5 rounded-full transition-transform duration-150",
              alerts ? "translate-x-[1.35rem] bg-ink-950" : "translate-x-[0.2rem] bg-fg-muted",
            )}
          />
        </button>
      </div>

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p
          role="status"
          aria-live="polite"
          className={cn("min-h-5 text-sm", status?.ok ? "text-brand-300" : "text-coral-400")}
        >
          {status?.text}
        </p>
        <Button type="submit" size="lg" disabled={pending} className="w-full sm:w-auto">
          {pending ? "Saving…" : "Save settings"}
        </Button>
      </div>
    </form>
  );
}
