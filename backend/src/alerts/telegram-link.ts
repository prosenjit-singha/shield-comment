import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  TELEGRAM_CHAT_TYPES,
  type TelegramChatType,
} from '../db/schema/index.js';
import { RedisService } from '../redis/redis.service.js';

/**
 * Telegram chat linking (M7-T8, D13): owner/admin gets a one-time `t.me/<bot>?start=<code>` link
 * (15 min); the bot receives `/start <code>` in a private chat or a group and links that chat.
 * Pure helpers + the Redis code store.
 */

export const TELEGRAM_LINK_TTL_SECONDS = 15 * 60;
/** 24 random bytes → 32 base64url chars (Telegram start params: A-Z a-z 0-9 _ -, ≤ 64). */
const CODE_BYTES = 24;
const CODE_FORMAT = /^[A-Za-z0-9_-]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TITLE_MAX = 128;

export interface TelegramLinkData {
  workspaceId: string;
  /** Who created the code (`telegram_chats.linked_by_user_id`). */
  userId: string;
}

export function generateTelegramLinkCode(): string {
  return randomBytes(CODE_BYTES).toString('base64url');
}

/** Redis key: sha256 of the code, so a Redis dump can't be replayed through the bot. */
export function telegramLinkKey(code: string): string {
  return `telegram:link:${createHash('sha256').update(code, 'utf8').digest('hex')}`;
}

export function parseTelegramLinkData(
  raw: string | null,
): TelegramLinkData | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      typeof value === 'object' &&
      value !== null &&
      'workspaceId' in value &&
      'userId' in value &&
      typeof value.workspaceId === 'string' &&
      typeof value.userId === 'string' &&
      UUID.test(value.workspaceId) &&
      UUID.test(value.userId)
    )
      return { workspaceId: value.workspaceId, userId: value.userId };
  } catch {
    // corrupt value = unknown code
  }
  return null;
}

/** Constant-time check of `X-Telegram-Bot-Api-Secret-Token` (hashing equalises the lengths). */
export function isTelegramSecretValid(
  header: string | undefined,
  secret: string,
): boolean {
  if (typeof header !== 'string' || header.length === 0) return false;
  const digest = (v: string) => createHash('sha256').update(v, 'utf8').digest();
  return timingSafeEqual(digest(header), digest(secret));
}

export interface TelegramStartCommand {
  chatId: number;
  chatType: TelegramChatType;
  title: string;
  /** `null` = `/start` without a (well-formed) code. */
  code: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function chatTitle(chat: Record<string, unknown>): string {
  const str = (key: string) =>
    typeof chat[key] === 'string' ? chat[key].trim() : '';
  const name =
    str('title') ||
    [str('first_name'), str('last_name')].filter(Boolean).join(' ') ||
    (str('username') ? `@${str('username')}` : '') ||
    'Telegram chat';
  return name.slice(0, TITLE_MAX);
}

/**
 * The `/start` command of a Telegram `Update`, or `null` for anything else (other updates,
 * channels, other commands, `/start@another_bot`). Groups send `/start@<bot> <code>`.
 */
export function parseTelegramStart(
  update: unknown,
  botUsername: string,
): TelegramStartCommand | null {
  if (!isRecord(update) || !isRecord(update.message)) return null;
  const { chat, text } = update.message;
  if (!isRecord(chat) || typeof text !== 'string') return null;
  const chatId = chat.id;
  const chatType = chat.type;
  if (
    typeof chatId !== 'number' ||
    !Number.isSafeInteger(chatId) ||
    !TELEGRAM_CHAT_TYPES.includes(chatType as TelegramChatType)
  )
    return null;
  const match = /^\/start(?:@([A-Za-z0-9_]+))?(?:\s+(\S+))?\s*$/.exec(
    text.trim(),
  );
  if (!match) return null;
  if (match[1] && match[1].toLowerCase() !== botUsername.toLowerCase())
    return null;
  const code = match[2] && CODE_FORMAT.test(match[2]) ? match[2] : null;
  return {
    chatId,
    chatType: chatType as TelegramChatType,
    title: chatTitle(chat),
    code,
  };
}

/** Bot replies: English, then Bangla (reading 10); no ids, no codes. */
export const TELEGRAM_BOT_REPLIES = {
  linked: (workspaceName: string) =>
    `ShieldComment BD: this chat is now linked to "${workspaceName}". Scam-spike alerts will arrive here.\n\n` +
    `ShieldComment BD: এই চ্যাটটি "${workspaceName}"-এর সাথে যুক্ত হয়েছে। স্ক্যাম বেড়ে গেলে অ্যালার্ট এখানে আসবে।`,
  invalidCode:
    'This link has expired or was already used. Open Settings → Alerts in ShieldComment BD and create a new link.\n\n' +
    'এই লিংকের মেয়াদ শেষ বা এটি আগেই ব্যবহার হয়েছে। ShieldComment BD-তে Settings → Alerts খুলে নতুন লিংক তৈরি করুন।',
  limitReached:
    'This workspace already has 3 linked Telegram chats. Remove one in Settings → Alerts, then create a new link.\n\n' +
    'এই ওয়ার্কস্পেসে ইতিমধ্যে ৩টি টেলিগ্রাম চ্যাট যুক্ত আছে। Settings → Alerts থেকে একটি সরিয়ে নতুন লিংক তৈরি করুন।',
} as const;

/** One-time link codes. Abstract class = DI token; e2e swaps in a memory store (Redis is stubbed). */
export abstract class TelegramLinkStore {
  abstract save(
    code: string,
    data: TelegramLinkData,
    ttlSeconds: number,
  ): Promise<void>;
  /** Reads and deletes in one step; `null` when missing, expired, used or corrupt. */
  abstract take(code: string): Promise<TelegramLinkData | null>;
}

@Injectable()
export class RedisTelegramLinkStore extends TelegramLinkStore {
  constructor(private readonly redis: RedisService) {
    super();
  }

  async save(
    code: string,
    data: TelegramLinkData,
    ttlSeconds: number,
  ): Promise<void> {
    const reply = await (
      await this.connected()
    ).set(telegramLinkKey(code), JSON.stringify(data), 'EX', ttlSeconds, 'NX');
    if (reply !== 'OK') throw new Error('Telegram link key already exists');
  }

  async take(code: string): Promise<TelegramLinkData | null> {
    // GETDEL: two `/start`s with the same code can't both pass.
    return parseTelegramLinkData(
      await (await this.connected()).getdel(telegramLinkKey(code)),
    );
  }

  private async connected() {
    const { client } = this.redis;
    if (client.status === 'wait') await client.connect();
    return client;
  }
}
