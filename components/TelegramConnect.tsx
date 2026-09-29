"use client";
/** "Connect Telegram": asks for a one-time link, then offers to open t.me/<bot>?start=<code>. */
import { useState, useTransition } from "react";
import { sendJson } from "./api";
import { Button, buttonClasses } from "./ui/Button";
import { Tag } from "./ui/Badge";

export function TelegramConnect({ linked, configured }: { linked: boolean; configured: boolean }) {
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
        {linked ? <Tag tone="yes">Linked</Tag> : <Tag>Not linked</Tag>}
        {!configured && <Tag tone="amber">Alerts logged, Telegram off</Tag>}
      </div>
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
              Telegram.
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
