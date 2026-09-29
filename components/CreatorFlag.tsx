import { cn } from "./ui/cn";

/**
 * Creator flag pill (hard requirement 5). Shown wherever a trade (or trader)
 * involves a market the trader created. `verified=false` means the creator was
 * inferred from the create tx fee payer and is not yet confirmed.
 */
export function CreatorFlag({ count, verified, className }: { count?: number; verified: boolean; className?: string }) {
  const label = count && count > 1 ? `Traded own market ×${count}` : "Traded own market";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-[var(--radius-pill)] bg-amber-300/10 px-2.5 py-1 text-xs font-semibold text-amber-300 ring-1 ring-inset ring-amber-300/30",
        className,
      )}
      title={verified ? "This trader created the market they traded." : "Creator inferred from the market's create transaction (unverified)."}
    >
      <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3.5 fill-current">
        <path d="M8 1.5a.75.75 0 0 1 .67.41l6 11.5A.75.75 0 0 1 14 14.5H2a.75.75 0 0 1-.67-1.09l6-11.5A.75.75 0 0 1 8 1.5Zm0 4a.75.75 0 0 0-.75.75v3a.75.75 0 0 0 1.5 0v-3A.75.75 0 0 0 8 5.5Zm0 6.75a.9.9 0 1 0 0-1.8.9.9 0 0 0 0 1.8Z" />
      </svg>
      <span>{label}</span>
      {!verified && <span className="font-medium text-amber-300/80">· unverified</span>}
    </span>
  );
}
