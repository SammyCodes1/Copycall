"use client";
/**
 * Connect + sign-in button.
 * Flow: pick Phantom/Solflare -> connect -> POST /api/auth/nonce -> wallet signs
 * the SIWS message (signMessage, no transaction) -> POST /api/auth/verify sets
 * the HttpOnly session cookie -> refresh server components.
 */
import { WalletReadyState, type WalletName } from "@solana/wallet-adapter-base";
import { useWallet } from "@solana/wallet-adapter-react";
import bs58 from "bs58";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "./ui/Button";
import { cn } from "./ui/cn";

const SUPPORTED = ["Phantom", "Solflare"];
const INSTALL_URL: Record<string, string> = {
  Phantom: "https://phantom.com/download",
  Solflare: "https://solflare.com/download",
};

const noopSubscribe = () => () => {};
/** false during SSR/hydration, true after: wallet detection only exists in the browser. */
function useIsClient() {
  return useSyncExternalStore(noopSubscribe, () => true, () => false);
}

export function shortAddress(a: string) {
  return `${a.slice(0, 4)}…${a.slice(-4)}`;
}

async function postJson(url: string, body?: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  const data = (await res.json().catch(() => ({}))) as { message?: string } & Record<string, unknown>;
  if (!res.ok) throw new Error(data.message ?? "Request failed");
  return data;
}

export function WalletButton({ sessionWallet, size = "md" }: { sessionWallet: string | null; size?: "md" | "lg" }) {
  const router = useRouter();
  const { wallets, wallet, select, connect, disconnect, connected, publicKey, signMessage } = useWallet();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState<null | "connecting" | "signing" | "logout">(null);
  const [error, setError] = useState<string | null>(null);
  const [wantConnect, setWantConnect] = useState(false);
  const isClient = useIsClient();

  const options = wallets.filter((w) => SUPPORTED.includes(w.adapter.name));

  const signIn = useCallback(async () => {
    if (!publicKey || !signMessage) {
      setError("This wallet can't sign messages.");
      return;
    }
    setBusy("signing");
    setError(null);
    try {
      const wallet58 = publicKey.toBase58();
      const { nonce, message } = (await postJson("/api/auth/nonce", { wallet: wallet58 })) as {
        nonce: string;
        message: string;
      };
      const sig = await signMessage(new TextEncoder().encode(message));
      await postJson("/api/auth/verify", { wallet: wallet58, nonce, signature: bs58.encode(sig) });
      dialogRef.current?.close();
      router.refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Sign-in failed";
      setError(/reject/i.test(msg) ? "Signature request rejected." : msg);
    } finally {
      setBusy(null);
    }
  }, [publicKey, signMessage, router]);

  // After select(), the adapter context updates on the next render; connect then.
  useEffect(() => {
    if (!wantConnect || !wallet || connected) return;
    let cancelled = false;
    connect()
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error && e.message ? e.message : "Connection rejected.");
      })
      .finally(() => {
        if (!cancelled) {
          setWantConnect(false);
          setBusy(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [wantConnect, wallet, connected, connect]);

  function choose(name: WalletName, ready: WalletReadyState) {
    setError(null);
    if (ready === WalletReadyState.NotDetected || ready === WalletReadyState.Unsupported) {
      window.open(INSTALL_URL[name] ?? "https://solana.com/ecosystem/explore?categories=wallet", "_blank", "noopener");
      return;
    }
    setBusy("connecting");
    if (wallet?.adapter.name === name) setWantConnect(true);
    else {
      select(name);
      setWantConnect(true);
    }
  }

  async function logout() {
    setBusy("logout");
    try {
      await postJson("/api/auth/logout");
      await disconnect().catch(() => undefined);
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  if (sessionWallet) {
    return (
      <div className="flex items-center gap-2">
        <span className="glass inline-flex h-9 items-center gap-2 rounded-[var(--radius-pill)] px-3 text-sm font-medium tabular-nums">
          <span aria-hidden className="size-2 rounded-full bg-brand-400 shadow-[0_0_10px_rgb(52_192_95/0.8)]" />
          <span className="sr-only">Signed in as </span>
          {shortAddress(sessionWallet)}
        </span>
        <Button variant="ghost" size="sm" onClick={logout} disabled={busy !== null}>
          Log out
        </Button>
      </div>
    );
  }

  const connectedNotSignedIn = connected && publicKey;

  return (
    <>
      <Button
        size={size === "lg" ? "lg" : "md"}
        onClick={() => {
          setError(null);
          dialogRef.current?.showModal();
        }}
      >
        <WalletIcon />
        {isClient && connectedNotSignedIn ? "Sign in" : "Connect wallet"}
      </Button>

      <dialog
        ref={dialogRef}
        aria-labelledby="wallet-dialog-title"
        className="glass-strong m-auto w-[min(92vw,26rem)] rounded-[var(--radius-glass)] p-0 text-fg backdrop:bg-black/60 backdrop:backdrop-blur-sm"
        onClick={(e) => {
          if (e.target === dialogRef.current) dialogRef.current?.close();
        }}
      >
        <div className="p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 id="wallet-dialog-title" className="font-display text-xl font-semibold">
                {connectedNotSignedIn ? "Sign in" : "Connect a wallet"}
              </h2>
              <p className="mt-1 text-sm text-fg-muted">
                {connectedNotSignedIn
                  ? "Sign a message to prove you own this wallet. No transaction, no fees."
                  : "Copycall never holds your funds or keys."}
              </p>
            </div>
            <button
              type="button"
              aria-label="Close"
              onClick={() => dialogRef.current?.close()}
              className="-m-1 rounded-full p-1.5 text-fg-subtle hover:bg-white/5 hover:text-fg"
            >
              <svg aria-hidden viewBox="0 0 20 20" className="size-5 fill-current">
                <path d="M5.3 5.3a1 1 0 0 1 1.4 0L10 8.6l3.3-3.3a1 1 0 1 1 1.4 1.4L11.4 10l3.3 3.3a1 1 0 0 1-1.4 1.4L10 11.4l-3.3 3.3a1 1 0 0 1-1.4-1.4L8.6 10 5.3 6.7a1 1 0 0 1 0-1.4Z" />
              </svg>
            </button>
          </div>

          {!isClient ? null : connectedNotSignedIn ? (
            <div className="mt-6 space-y-3">
              <div className="glass flex items-center justify-between rounded-2xl px-4 py-3 text-sm">
                <span className="text-fg-muted">{wallet?.adapter.name}</span>
                <span className="font-mono tabular-nums">{shortAddress(publicKey.toBase58())}</span>
              </div>
              <Button className="w-full" size="lg" onClick={signIn} disabled={busy !== null}>
                {busy === "signing" ? "Check your wallet…" : "Sign message"}
              </Button>
              <Button className="w-full" variant="ghost" size="sm" onClick={() => disconnect()} disabled={busy !== null}>
                Use a different wallet
              </Button>
            </div>
          ) : (
            <ul className="mt-6 space-y-2">
              {options.map((w) => {
                const installed =
                  w.readyState === WalletReadyState.Installed || w.readyState === WalletReadyState.Loadable;
                return (
                  <li key={w.adapter.name}>
                    <button
                      type="button"
                      onClick={() => choose(w.adapter.name, w.readyState)}
                      disabled={busy !== null}
                      className={cn(
                        "glass flex w-full items-center gap-3 rounded-2xl px-4 py-3 text-left transition",
                        "hover:border-white/20 hover:bg-white/[0.07] disabled:opacity-60",
                      )}
                    >
                      {/* Wallet icons are data: URIs supplied by the adapter packages */}
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={w.adapter.icon} alt="" className="size-8 rounded-lg" />
                      <span className="flex-1 font-semibold">{w.adapter.name}</span>
                      <span className="text-xs text-fg-subtle">
                        {busy === "connecting" && wallet?.adapter.name === w.adapter.name
                          ? "Connecting…"
                          : installed
                            ? w.readyState === WalletReadyState.Installed
                              ? "Detected"
                              : "Open"
                            : "Install ↗"}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {error && (
            <p role="alert" className="mt-4 rounded-xl bg-coral-400/10 px-3 py-2 text-sm text-coral-400 ring-1 ring-coral-400/25">
              {error}
            </p>
          )}
        </div>
      </dialog>
    </>
  );
}

function WalletIcon() {
  return (
    <svg aria-hidden viewBox="0 0 20 20" className="size-4 fill-current">
      <path d="M3 5.5A2.5 2.5 0 0 1 5.5 3h8A1.5 1.5 0 0 1 15 4.5V6h.5A1.5 1.5 0 0 1 17 7.5v8a1.5 1.5 0 0 1-1.5 1.5h-10A2.5 2.5 0 0 1 3 14.5v-9Zm2.5-1a1 1 0 0 0 0 2H13.5v-2h-8ZM13 11a1.25 1.25 0 1 0 2.5 0A1.25 1.25 0 0 0 13 11Z" />
    </svg>
  );
}
