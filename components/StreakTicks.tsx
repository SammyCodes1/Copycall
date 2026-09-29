import { cn } from "./ui/cn";

/**
 * Compact W/L streak of recent resolved calls (oldest -> newest).
 * Wins are tall green ticks, losses short coral ticks, so the pattern reads
 * without relying on colour alone. Screen readers get a text summary.
 */
export function StreakTicks({ results, className }: { results: Array<"W" | "L">; className?: string }) {
  const wins = results.filter((r) => r === "W").length;
  return (
    <span
      role="img"
      aria-label={`Last ${results.length} resolved calls: ${wins} won, ${results.length - wins} lost`}
      className={cn("inline-flex h-4 items-end gap-[3px]", className)}
    >
      {results.map((r, i) => (
        <span
          key={i}
          className={cn("w-[3px] rounded-[var(--radius-tick)]", r === "W" ? "h-4 bg-brand-400" : "h-2 bg-coral-400/90")}
        />
      ))}
    </span>
  );
}
