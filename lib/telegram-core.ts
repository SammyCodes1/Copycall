/**
 * Telegram linking logic (MVP feature 6), independent of grammY so it can be
 * unit-tested. lib/telegram.ts wires these into bot handlers.
 *
 * Linking is two steps (audit B2-01): /start <code> only SHOWS the wallet the
 * code belongs to and asks for confirmation with an inline button; the chat is
 * linked when that button is pressed. Whoever loses the chat is told, and
 * their settings page shows "Telegram unlinked".
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

export async function createLinkCode(store: DataStore, userId: string, wallet: string, nowSec: number) {
  const code = newLinkCode();
  const expiresAt = nowSec + LINK_CODE_TTL_SEC;
  await store.createLinkCode(userId, wallet, hashLinkCode(code), expiresAt);
  return { code, expiresAt };
}

export type ChatInfo = { id: number; type: string };

/** Inline keyboard button (subset of Telegram's InlineKeyboardButton). */
export type InlineButton = { text: string; callback_data: string };
export type BotReply = { text: string; buttons?: InlineButton[][] };
export type BotNotice = { chatId: number; text: string };

const CODE = /^[A-Za-z0-9_-]{16,64}$/;
const LINK_DATA = /^link:([A-Za-z0-9_-]{16,64})$/; // callback_data is at most 64 bytes: 5 + 32 in practice
export const CANCEL_DATA = "cancel";

export const shortWallet = (w: string) => (w.length > 8 ? `${w.slice(0, 4)}…${w.slice(-4)}` : w);

const EXPIRED = "That link has expired or was already used. Create a new one from your Copycall settings.";

/** /start <code>: show which wallet would be linked and ask to confirm. Links nothing. */
export async function handleStart(store: DataStore, chat: ChatInfo, payload: string): Promise<BotReply> {
  if (chat.type !== "private") return { text: "Please message me directly to link Copycall alerts." };
  const code = payload.trim();
  if (!code) return { text: "Hi! To get copy alerts, press “Connect Telegram” on your Copycall settings page." };
  if (!CODE.test(code)) return { text: "That link isn't valid. Create a new one from your Copycall settings." };
  const found = await store.peekLinkCode(hashLinkCode(code));
  if (!found) return { text: EXPIRED };
  const w = shortWallet(found.wallet);
  const current = await store.linkedWalletForChat(chat.id);
  const lines = [
    `Link this chat to Copycall wallet ${w}?`,
    "Only continue if that is YOUR wallet (it's shown in the Copycall header when you're signed in). Alerts for this wallet will come here.",
  ];
  if (current && current !== found.wallet) {
    lines.push(`This chat currently gets alerts for wallet ${shortWallet(current)}. Linking moves the chat to ${w}.`);
  }
  if (current === found.wallet) lines.push("This chat is already linked to that wallet.");
  return {
    text: lines.join("\n\n"),
    buttons: [
      [{ text: `Link wallet ${w}`, callback_data: `link:${code}` }],
      [{ text: "Cancel", callback_data: CANCEL_DATA }],
    ],
  };
}

export type ConfirmInput = {
  chat: ChatInfo | undefined; // chat of the message holding the button
  fromId: number; // user who pressed it
  data: string | undefined;
};

/**
 * Inline "Link wallet" button. Links the chat, then returns the reply for this
 * chat plus notices for anyone who lost it (sent to their previous chat).
 */
export async function handleLinkConfirm(
  store: DataStore,
  { chat, fromId, data }: ConfirmInput,
): Promise<{ reply: string; notices: BotNotice[] }> {
  // Private chats only, and the presser must be that chat's user.
  if (!chat || chat.type !== "private" || chat.id !== fromId) {
    return { reply: "Please message me directly to link Copycall alerts.", notices: [] };
  }
  if (data === CANCEL_DATA) return { reply: "Cancelled. Nothing was linked.", notices: [] };
  const m = LINK_DATA.exec(data ?? "");
  if (!m)
    return { reply: "That button isn't valid anymore. Create a new link from your Copycall settings.", notices: [] };
  const r = await store.linkTelegramChat(hashLinkCode(m[1]), chat.id);
  if (!r) return { reply: EXPIRED, notices: [] };

  const w = shortWallet(r.wallet);
  const lines = [
    `Linked to wallet ${w}. You'll get a message here when a trader you follow buys. Send /stop to pause alerts.`,
  ];
  if (r.previousUserId && r.previousWallet) {
    // The account that lost this chat is notified right here (it's their chat), and in their settings.
    lines.push(`Wallet ${shortWallet(r.previousWallet)} was unlinked from this chat and no longer sends alerts here.`);
  }
  const notices: BotNotice[] = [];
  if (r.previousChatId !== null) {
    notices.push({
      chatId: r.previousChatId,
      text: `Copycall alerts for wallet ${w} moved to another Telegram chat, so this chat won't get them anymore. If that wasn't you, sign in to Copycall and connect Telegram again.`,
    });
  }
  return { reply: lines.join("\n\n"), notices };
}

/** /stop: pause alerts for whoever is linked to this chat. */
export async function handleStop(store: DataStore, chat: ChatInfo): Promise<string> {
  const n = await store.pauseAlertsForChat(chat.id);
  return n > 0
    ? "Alerts paused. Turn them back on in your Copycall settings."
    : "No active alerts are linked to this chat.";
}

export const HELP_TEXT =
  "Copycall alerts. Commands: /stop pauses alerts. Link or re-enable from your Copycall settings page.";
