import Link from "next/link";
import { Logo } from "./Logo";
import { WalletButton } from "./WalletButton";

/** Frosted sticky header: glass here is functional (the tape and table scroll beneath it). */
export function Header({ sessionWallet }: { sessionWallet: string | null }) {
  return (
    <header className="glass sticky top-0 z-40 border-x-0 border-t-0">
      <div className="mx-auto flex h-14 max-w-[76rem] items-center justify-between gap-4 px-4 sm:px-6">
        <div className="flex items-center gap-8">
          <Link href="/" aria-label="Copycall home" className="-m-1 rounded-[var(--radius-control)] p-1">
            <Logo />
          </Link>
          <nav aria-label="Sections" className="hidden items-center gap-1 md:flex">
            {[
              ["/#leaderboard", "Leaderboard"],
              ["/#anatomy", "How a copy works"],
            ].map(([href, label]) => (
              <a
                key={href}
                href={href}
                className="rounded-[var(--radius-control)] px-2.5 py-1.5 text-sm text-fg-muted transition-colors hover:bg-white/[0.04] hover:text-fg"
              >
                {label}
              </a>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-1 sm:gap-2">
          {sessionWallet && (
            <Link
              href="/settings"
              aria-label="Settings"
              className="inline-flex h-9 min-w-9 items-center justify-center rounded-[var(--radius-control)] text-sm text-fg-muted transition-colors hover:bg-white/[0.04] hover:text-fg sm:px-2.5"
            >
              {/* Gear on phones (space), text from sm up */}
              <svg aria-hidden="true" viewBox="0 0 20 20" className="size-[18px] fill-none stroke-current sm:hidden" strokeWidth="1.6">
                <circle cx="10" cy="10" r="2.6" />
                <path d="M10 2.5v2.1M10 15.4v2.1M17.5 10h-2.1M4.6 10H2.5M15.3 4.7l-1.5 1.5M6.2 13.8l-1.5 1.5M15.3 15.3l-1.5-1.5M6.2 6.2 4.7 4.7" />
              </svg>
              <span className="hidden sm:inline">Settings</span>
            </Link>
          )}
          <WalletButton sessionWallet={sessionWallet} size="sm" />
        </div>
      </div>
    </header>
  );
}
