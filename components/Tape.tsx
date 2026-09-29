import type { TapeItem } from "@/lib/view-types";
import { ago, shortAddr } from "./format";
import { SideTag } from "./ui/Badge";

/**
 * Ticker tape of recent calls. The list is rendered twice for a seamless loop;
 * the copy is aria-hidden. Pauses on hover/focus; static + scrollable under
 * prefers-reduced-motion. Labelled "Sample tape" in mock mode.
 */
export function Tape({ items, nowSec, sample }: { items: TapeItem[]; nowSec: number; sample: boolean }) {
  if (items.length === 0) return null;
  const row = (hidden: boolean) => (
    <ul aria-hidden={hidden || undefined} className="flex shrink-0 items-center">
      {items.map((t) => (
        <li key={t.signature + String(hidden)} className="flex items-center gap-2 border-r border-line px-4 text-sm">
          <span className="num text-fg-muted">{shortAddr(t.wallet)}</span>
          <span className="text-fg-subtle">bought</span>
          <SideTag side={t.side} />
          <span className="num text-fg">{t.shares}</span>
          <span className="max-w-[16rem] truncate text-fg-muted">{t.title}</span>
          {t.isCreatorTrade && <span className="label text-amber-300">Own mkt</span>}
          <span className="num text-xs text-fg-subtle">{ago(t.blockTime, nowSec)}</span>
        </li>
      ))}
    </ul>
  );
  return (
    <section aria-label={sample ? "Sample tape of recent calls" : "Recent calls"} className="tape relative border-b border-line bg-ink-950/60">
      <div className="flex h-10 items-stretch">
        <p className="label z-10 flex shrink-0 items-center gap-2 border-r border-line bg-ink-950 px-4 text-fg-muted">
          <span aria-hidden className="size-1.5 animate-blink rounded-full bg-amber-300" />
          {sample ? "Sample tape" : "Recent calls"}
        </p>
        <div className="tape-viewport relative flex-1 overflow-hidden [mask-image:linear-gradient(90deg,transparent,black_2rem,black_calc(100%-2rem),transparent)]">
          <div className="tape-track flex h-full w-max items-center">
            {row(false)}
            {row(true)}
          </div>
        </div>
      </div>
    </section>
  );
}
