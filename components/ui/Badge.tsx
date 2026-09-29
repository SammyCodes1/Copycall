import type { ReactNode } from "react";
import { cn } from "./cn";

type Tone = "brand" | "lime" | "neutral" | "coral" | "amber";

const tones: Record<Tone, string> = {
  brand: "bg-brand-500/15 text-brand-300 ring-brand-500/30",
  lime: "bg-lime-400/12 text-lime-400 ring-lime-400/25",
  neutral: "bg-white/[0.06] text-fg-muted ring-white/10",
  coral: "bg-coral-400/12 text-coral-400 ring-coral-400/30",
  amber: "bg-amber-300/10 text-amber-300 ring-amber-300/30",
};

export function Badge({ tone = "neutral", className, children }: { tone?: Tone; className?: string; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-[var(--radius-pill)] px-2.5 py-1 text-xs font-semibold tabular-nums ring-1 ring-inset",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Hit-rate badge: colour steps by quality, always shows the number (not colour alone). */
export function HitRateBadge({ hitRate, calls }: { hitRate: number; calls: number }) {
  const pct = Math.round(hitRate * 100);
  const tone: Tone = pct >= 70 ? "brand" : pct >= 55 ? "lime" : pct >= 45 ? "neutral" : "coral";
  return (
    <span className="inline-flex items-center gap-2">
      <Badge tone={tone} className="min-w-[3.5rem] justify-center text-sm">
        {pct}%
      </Badge>
      <span className="text-xs text-fg-subtle tabular-nums">
        {calls} {calls === 1 ? "call" : "calls"}
      </span>
    </span>
  );
}
