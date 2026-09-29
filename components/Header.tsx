import Link from "next/link";
import { Logo } from "./Logo";
import { WalletButton } from "./WalletButton";

export function Header({ sessionWallet }: { sessionWallet: string | null }) {
  return (
    <header className="sticky top-0 z-40">
      <div className="mx-auto max-w-6xl px-3 pt-3 sm:px-6">
        <div className="glass flex h-14 items-center justify-between gap-3 rounded-[var(--radius-pill)] pl-3 pr-2 sm:pl-4">
          <Link href="/" aria-label="Copycall home" className="rounded-full">
            <Logo />
          </Link>
          <WalletButton sessionWallet={sessionWallet} />
        </div>
      </div>
    </header>
  );
}
