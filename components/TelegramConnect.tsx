"use client";
/** "Connect Telegram": asks for a one-time link, then offers to open t.me/<bot>?start=<code>. */
import { useState, useTransition } from "react";
import { sendJson } from "./api";
import { Button, buttonClasses } from "./ui/Button";
import { Tag } from "./ui/Badge";

export function TelegramConnect({
  linked,
  configured,
  unlinkedAt = null,
}: {
  linked: boolean;
  configured: boolean;
  /** Set when another Copycall wallet took over this account's chat (unix seconds). */
  unlinkedAt?: number | null;
}) {
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function create() {
    setError(null);
    startTransition(async () => {
      try {
        setLink(await sendJson<{ url: string; expiresAt: string }>("POST", "/api/telegram/link"));
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't create a link");
      }
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {linked ? (
          <Tag tone="yes">Linked</Tag>
        ) : unlinkedAt ? (
          <Tag tone="amber">Telegram unlinked</Tag>
        ) : (
          <Tag>Not linked</Tag>
        )}
        {!configured && <Tag tone="amber">Alerts logged, Telegram off</Tag>}
      </div>
      {!linked && unlinkedAt && (
        <p
          role="status"
          className="rounded-[var(--radius-control)] border border-amber-300/30 bg-amber-300/[0.06] px-3 py-2 text-sm leading-6 text-fg"
        >
          Your Telegram chat was linked to a different Copycall wallet on{" "}
          {new Date(unlinkedAt * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}, so alerts
          stopped going there. If that wasn&apos;t you, connect Telegram again and only confirm your own wallet in the
          bot.
        </p>
      )}
      <p className="text-sm leading-6 text-fg-muted">
        {configured
          ? "Get a plain-text message when a trader you follow buys, with a link to review the copy here. Send /stop to the bot to pause."
          : "Telegram isn't configured on this server, so alerts are written to the server log instead of being sent."}{" "}
        Alerts can lag a few minutes.
      </p>
      {configured && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          {link ? (
            <a
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonClasses("primary", "lg", "w-full sm:w-auto")}
            >
              Open Telegram
            </a>
          ) : (
            <Button
              size="lg"
              variant={linked ? "secondary" : "primary"}
              onClick={create}
              disabled={pending}
              className="w-full sm:w-auto"
            >
              {pending ? "Creating link…" : linked ? "Link a different chat" : "Connect Telegram"}
            </Button>
          )}
          {link && (
            <p className="text-xs text-fg-subtle">
              One-time link, expires at{" "}
              {new Date(link.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}. Press Start in
              Telegram, check the wallet it shows is yours, then tap Link.
            </p>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-coral-400">
          {error}
        </p>
      )}
    </div>
  );
}
