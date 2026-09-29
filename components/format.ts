/** Shared display formatters (pure). */
export function shortAddr(a: string) {
  return `${a.slice(0, 4)}…${a.slice(-4)}`;
}

/** Compact relative time against a reference "now" (unix seconds). */
export function ago(unix: number | null, nowSec: number) {
  if (unix === null) return "—";
  const s = Math.max(0, nowSec - unix);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}
