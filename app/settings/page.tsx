import type { Metadata } from "next";
import Link from "next/link";
import { FollowButton } from "@/components/FollowButton";
import { SettingsForm } from "@/components/SettingsForm";
import { TelegramConnect } from "@/components/TelegramConnect";
import { WalletButton } from "@/components/WalletButton";
import { ago, shortAddr } from "@/components/format";
import { HitRate } from "@/components/ui/Badge";
import { getSession } from "@/lib/auth";
import { ensureMockData, getDataStore } from "@/lib/data";
import { displayNowSec } from "@/lib/queries";
import { stakeCapOrNull } from "@/lib/flow";
import { usdcExact } from "@/lib/copy-math";
import { isTelegramConfigured } from "@/lib/telegram";

export const metadata: Metadata = { title: "Settings · Copycall" };

/** /settings: copy limits, alerts, and the traders you follow. Session required. */
export default async function SettingsPage() {
  const session = await getSession();

  if (!session) {
    return (
      <div className="mx-auto max-w-[40rem] px-4 pb-16 pt-12 sm:px-6 sm:pt-20">
        <h1 className="font-display text-[2.75rem] leading-[3rem] tracking-[-0.015em]">Settings</h1>
        <section className="card mt-6 px-5 py-8 sm:px-8">
          <h2 className="text-lg font-semibold">Sign in to manage your settings</h2>
          <p className="mt-2 text-sm leading-6 text-fg-muted">
            Connect your wallet and sign a one-time message. No transaction, no fees.
          </p>
          <WalletButton sessionWallet={null} size="lg" className="mt-6 w-full sm:w-auto" />
        </section>
      </div>
    );
  }

  await ensureMockData();
  const store = getDataStore();
  const [settings, follows] = await Promise.all([store.getSettings(session.uid), store.listFollows(session.uid)]);
  const stats = new Map(
    (await Promise.all(follows.map((f) => store.getTraderStats(f.wallet)))).flatMap((s) =>
      s ? [[s.wallet, s] as const] : [],
    ),
  );
  const nowSec = displayNowSec();
  const cap = stakeCapOrNull(); // the launch cap (MAX_STAKE_USDC); the server enforces it on every copy

  return (
    <div className="mx-auto max-w-[48rem] px-4 pb-16 sm:px-6">
      <header className="animate-rise pb-6 pt-10 sm:pt-14">
        <p className="label text-fg-subtle">Signed in as {shortAddr(session.w)}</p>
        <h1 className="mt-3 font-display text-[2.75rem] leading-[3rem] tracking-[-0.015em] sm:text-6xl sm:leading-[4rem]">
          Settings
        </h1>
        <p className="mt-3 max-w-[34rem] text-fg-muted">
          These limits apply to every copy. The copy screen always re-quotes with them; a link can&apos;t change them.
        </p>
      </header>

      <section aria-labelledby="limits-title" className="card px-4 py-5 sm:px-6 sm:py-6">
        <h2 id="limits-title" className="mb-5 font-display text-2xl">
          Copy limits
        </h2>
        {settings && <SettingsForm initial={settings} capUsdc={cap === null ? null : usdcExact(cap)} />}
      </section>

      <section aria-labelledby="telegram-title" className="card mt-6 px-4 py-5 sm:px-6 sm:py-6">
        <h2 id="telegram-title" className="mb-4 font-display text-2xl">
          Telegram alerts
        </h2>
        <TelegramConnect
          linked={settings?.telegramLinked ?? false}
          unlinkedAt={settings?.telegramUnlinkedAt ?? null}
          configured={isTelegramConfigured()}
        />
      </section>

      <section aria-labelledby="following-title" className="card mt-6 overflow-hidden">
        <div className="flex items-end justify-between gap-3 border-b border-line px-4 pb-3 pt-5 sm:px-6">
          <h2 id="following-title" className="font-display text-2xl">
            Following
          </h2>
          <span className="label text-fg-subtle">{follows.length}</span>
        </div>
        {follows.length === 0 ? (
          <p className="px-6 py-10 text-center text-sm text-fg-muted">
            You don&apos;t follow anyone yet.{" "}
            <Link href="/#leaderboard" className="text-brand-300 underline underline-offset-4">
              Pick a trader from the leaderboard
            </Link>
            .
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {follows.map((f) => {
              const s = stats.get(f.wallet);
              return (
                <li key={f.wallet} className="flex items-center justify-between gap-3 px-4 py-3 sm:px-6">
                  <div className="min-w-0">
                    <Link href={`/trader/${f.wallet}`} className="num text-fg hover:text-brand-300" title={f.wallet}>
                      {shortAddr(f.wallet)}
                    </Link>
                    <p className="num mt-0.5 text-xs text-fg-subtle">
                      {s ? `${s.resolvedCalls} calls · last ${ago(s.lastActive, nowSec)}` : "No stats yet"}
                    </p>
                  </div>
                  <div className="flex items-center gap-4">
                    {s && s.resolvedCalls > 0 && <HitRate hitRate={s.hitRate} className="text-lg" />}
                    <FollowButton wallet={f.wallet} initialFollowing size="sm" />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
