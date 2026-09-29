/**
 * Telegram linking logic (MVP feature 6), independent of grammY so it can be
 * unit-tested. lib/telegram.ts wires these into bot command handlers.
 */
import { createHash, randomBytes } from "node:crypto";
import type { DataStore } from "./data-store";

export const LINK_CODE_TTL_SEC = 10 * 60;

/** sha256 hex: what we store instead of the code itself. */
export function hashLinkCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

/** 32-char base64url code: fits Telegram's start parameter (A-Z a-z 0-9 _ -, max 64). */
export function newLinkCode(): string {
  return randomBytes(24).toString("base64url");
}

export async function createLinkCode(store: DataStore, userId: string, nowSec: number) {
  const code = newLinkCode();
  const expiresAt = nowSec + LINK_CODE_TTL_SEC;
  await store.createLinkCode(userId, hashLinkCode(code), expiresAt);
  return { code, expiresAt };
}

export type ChatInfo = { id: number; type: string };

const START_PAYLOAD = /^[A-Za-z0-9_-]{16,64}$/;

/** /start <code>. Only private chats can be linked. Returns the reply text. */
export async function handleStart(store: DataStore, chat: ChatInfo, payload: string): Promise<string> {
  if (chat.type !== "private") return "Please message me directly to link Copycall alerts.";
  const code = payload.trim();
  if (!code) return "Hi! To get copy alerts, press “Connect Telegram” on your Copycall settings page.";
  if (!START_PAYLOAD.test(code)) return "That link isn't valid. Create a new one from your Copycall settings.";
  const userId = await store.linkTelegramChat(hashLinkCode(code), chat.id);
  if (!userId) return "That link has expired or was already used. Create a new one from your Copycall settings.";
  return "Linked. You'll get a message here when a trader you follow buys. Send /stop to pause alerts.";
}

/** /stop: pause alerts for whoever is linked to this chat. */
export async function handleStop(store: DataStore, chat: ChatInfo): Promise<string> {
  const n = await store.pauseAlertsForChat(chat.id);
  return n > 0
    ? "Alerts paused. Turn them back on in your Copycall settings."
    : "No active alerts are linked to this chat.";
}

export const HELP_TEXT = "Copycall alerts. Commands: /stop pauses alerts. Link or re-enable from your Copycall settings page.";
