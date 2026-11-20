import type { RedisService } from '../redis/redis.service.js';
import {
  generateTelegramLinkCode,
  isTelegramSecretValid,
  parseTelegramLinkData,
  parseTelegramStart,
  RedisTelegramLinkStore,
  TELEGRAM_BOT_REPLIES,
  telegramLinkKey,
} from './telegram-link.js';

const BOT = 'ShieldTestBot';
const CODE = generateTelegramLinkCode();
const DATA = {
  workspaceId: '0192f5a4-7c3e-7a10-8b2c-3d4e5f6a7b8c',
  userId: '0192f5a4-7c3e-7a10-8b2c-3d4e5f6a7b8d',
};

const update = (text: unknown, chat: Record<string, unknown> = {}) => ({
  update_id: 1,
  message: {
    message_id: 1,
    chat: { id: 555, type: 'private', first_name: 'Karim', ...chat },
    text,
  },
});

describe('telegram link codes', () => {
  it('codes are 32 base64url chars and unique; the Redis key is a hash', () => {
    expect(CODE).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(generateTelegramLinkCode()).not.toBe(CODE);
    expect(telegramLinkKey(CODE)).toMatch(/^telegram:link:[0-9a-f]{64}$/);
    expect(telegramLinkKey(CODE)).not.toContain(CODE);
  });

  it('parses stored data; corrupt or foreign shapes are null', () => {
    expect(parseTelegramLinkData(JSON.stringify(DATA))).toEqual(DATA);
    expect(parseTelegramLinkData(null)).toBeNull();
    expect(parseTelegramLinkData('{')).toBeNull();
    expect(
      parseTelegramLinkData(JSON.stringify({ ...DATA, userId: 'x' })),
    ).toBeNull();
  });
});

describe('isTelegramSecretValid', () => {
  it('only the exact secret passes', () => {
    const secret = 'webhook-secret-0123456789';
    expect(isTelegramSecretValid(secret, secret)).toBe(true);
    expect(isTelegramSecretValid(`${secret}x`, secret)).toBe(false);
    expect(isTelegramSecretValid('short', secret)).toBe(false);
    expect(isTelegramSecretValid('', secret)).toBe(false);
    expect(isTelegramSecretValid(undefined, secret)).toBe(false);
  });
});

describe('parseTelegramStart', () => {
  it('private /start <code>', () => {
    expect(parseTelegramStart(update(`/start ${CODE}`), BOT)).toEqual({
      chatId: 555,
      chatType: 'private',
      title: 'Karim',
      code: CODE,
    });
  });

  it('group /start@bot <code> (bot name case-insensitive) uses the group title', () => {
    const parsed = parseTelegramStart(
      update(`/start@shieldtestbot ${CODE}`, {
        id: -100999,
        type: 'supergroup',
        title: ' Shop team ',
      }),
      BOT,
    );
    expect(parsed).toMatchObject({
      chatId: -100999,
      chatType: 'supergroup',
      title: 'Shop team',
      code: CODE,
    });
  });

  it('/start without a usable code → code null', () => {
    expect(parseTelegramStart(update('/start'), BOT)?.code).toBeNull();
    expect(parseTelegramStart(update('/start abc'), BOT)?.code).toBeNull();
  });

  it('title falls back to names, @username, then a default; capped at 128', () => {
    const title = (chat: Record<string, unknown>) =>
      parseTelegramStart(
        update('/start', { first_name: undefined, ...chat }),
        BOT,
      )?.title;
    expect(title({ first_name: 'A', last_name: 'B' })).toBe('A B');
    expect(title({ username: 'shop' })).toBe('@shop');
    expect(title({})).toBe('Telegram chat');
    expect(title({ first_name: 'x'.repeat(300) })).toHaveLength(128);
  });

  it.each([
    ['another bot', update(`/start@OtherBot ${CODE}`)],
    ['other text', update('hello')],
    ['other command', update(`/help ${CODE}`)],
    ['extra words', update(`/start ${CODE} now`)],
    ['no text', update(undefined)],
    ['channel', update(`/start ${CODE}`, { type: 'channel' })],
    ['unsafe chat id', update(`/start ${CODE}`, { id: 2 ** 60 })],
    ['edited message', { update_id: 1, edited_message: {} }],
    ['not an object', 'x'],
  ])('ignores %s', (_name, body) => {
    expect(parseTelegramStart(body, BOT)).toBeNull();
  });
});

describe('TELEGRAM_BOT_REPLIES', () => {
  it('are English then Bangla', () => {
    for (const text of [
      TELEGRAM_BOT_REPLIES.linked('Shop'),
      TELEGRAM_BOT_REPLIES.invalidCode,
      TELEGRAM_BOT_REPLIES.limitReached,
    ]) {
      const [en, bn] = text.split('\n\n');
      expect(en).toMatch(/^[\x20-\x7E"→]+$/u);
      expect(bn).toMatch(/[ঀ-৿]/u);
    }
  });
});

describe('RedisTelegramLinkStore', () => {
  function fakeRedis(status = 'ready') {
    const client = {
      status,
      connect: vi.fn().mockResolvedValue(undefined),
      set: vi.fn().mockResolvedValue('OK'),
      getdel: vi.fn().mockResolvedValue(null),
    };
    const store = new RedisTelegramLinkStore({
      client,
    } as unknown as RedisService);
    return { client, store };
  }

  it('SET … EX ttl NX under the hashed key; NX refusal throws', async () => {
    const { client, store } = fakeRedis('wait');
    await store.save(CODE, DATA, 900);
    expect(client.connect).toHaveBeenCalledOnce();
    expect(client.set).toHaveBeenCalledWith(
      telegramLinkKey(CODE),
      JSON.stringify(DATA),
      'EX',
      900,
      'NX',
    );
    client.set.mockResolvedValueOnce(null);
    await expect(store.save(CODE, DATA, 900)).rejects.toThrow('already exists');
  });

  it('take = GETDEL (single use)', async () => {
    const { client, store } = fakeRedis();
    client.getdel.mockResolvedValueOnce(JSON.stringify(DATA));
    await expect(store.take(CODE)).resolves.toEqual(DATA);
    expect(client.getdel).toHaveBeenCalledWith(telegramLinkKey(CODE));
    await expect(store.take(CODE)).resolves.toBeNull();
  });
});
