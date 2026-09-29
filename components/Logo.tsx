/** Copycall mark: a win tick and a loss tick, the atoms of the leaderboard. Our own artwork. */
export function Logo() {
  return (
    <span className="inline-flex items-center gap-2">
      <svg aria-hidden="true" viewBox="0 0 20 20" className="size-5">
        <rect x="0.5" y="0.5" width="19" height="19" rx="4.5" fill="none" stroke="rgb(255 255 255 / 0.18)" />
        <rect x="6" y="4.5" width="2.5" height="11" rx="1" fill="#34c05f" />
        <rect x="11.5" y="10" width="2.5" height="5.5" rx="1" fill="#ff6b7a" />
      </svg>
      <span className="text-[15px] font-semibold tracking-[-0.02em] text-fg">Copycall</span>
    </span>
  );
}
