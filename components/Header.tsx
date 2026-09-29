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
              ["#leaderboard", "Leaderboard"],
              ["#anatomy", "How a copy works"],
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
        <WalletButton sessionWallet={sessionWallet} size="sm" />
      </div>
    </header>
  );
}
