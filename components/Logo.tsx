/** Copycall wordmark + mark (our own artwork, not a Panta asset). */
export function Logo() {
  return (
    <span className="inline-flex items-center gap-2.5">
      <svg aria-hidden="true" viewBox="0 0 32 32" className="size-8">
        <defs>
          <linearGradient id="cc-g" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#78d02f" />
            <stop offset="1" stopColor="#23ad4e" />
          </linearGradient>
        </defs>
        <rect x="1" y="1" width="30" height="30" rx="9" fill="rgb(255 255 255 / 0.06)" stroke="rgb(255 255 255 / 0.14)" />
        <circle cx="13" cy="16" r="6.5" fill="none" stroke="url(#cc-g)" strokeWidth="2.5" />
        <circle cx="19.5" cy="16" r="6.5" fill="none" stroke="rgb(244 246 248 / 0.85)" strokeWidth="2.5" strokeDasharray="3 2.2" />
      </svg>
      <span className="font-display text-lg font-semibold tracking-tight text-fg">Copycall</span>
    </span>
  );
}
