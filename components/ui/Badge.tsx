import type { ReactNode } from "react";
import { cn } from "./cn";

type Tone = "yes" | "no" | "neutral" | "amber";

const tones: Record<Tone, string> = {
  yes: "text-brand-300 border-brand-500/40 bg-brand-500/10",
  no: "text-coral-400 border-coral-400/40 bg-coral-400/10",
  neutral: "text-fg-muted border-line-strong bg-white/[0.02]",
  amber: "text-amber-300 border-amber-300/40 bg-amber-300/[0.07]",
};

/** Precise outlined tag: mono, 11px caps, 4px radius. */
export function Tag({
  tone = "neutral",
  className,
  children,
}: {
  tone?: Tone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "label inline-flex h-5 items-center gap-1 rounded-[var(--radius-tag)] border px-1.5 font-medium",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** YES / NO side tag. Text carries the meaning; colour reinforces it. */
export function SideTag({ side, className }: { side: "yes" | "no"; className?: string }) {
  return (
    <Tag tone={side === "yes" ? "yes" : "no"} className={className}>
      {side === "yes" ? "Yes" : "No"}
    </Tag>
  );
}

/** Hit rate as a mono figure; colour steps by quality but the number is always shown. */
export function HitRate({ hitRate, className }: { hitRate: number; className?: string }) {
  const pct = Math.round(hitRate * 100);
  const tone = pct >= 70 ? "text-brand-300" : pct >= 55 ? "text-lime-400" : pct >= 45 ? "text-fg" : "text-coral-400";
  return (
    <span className={cn("num font-semibold", tone, className)}>
      {pct}
      <span className="ml-px text-[0.7em] font-medium text-fg-subtle">%</span>
    </span>
  );
}
