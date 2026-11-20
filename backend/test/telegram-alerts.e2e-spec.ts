import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { TELEGRAM_CONFIG } from '../src/alerts/telegram.client.js';
import {
  TELEGRAM_BOT_REPLIES,
  TelegramLinkStore,
} from '../src/alerts/telegram-link.js';
import { telegramChats } from '../src/db/schema/index.js';
import { type Actor, createAuthActors } from './utils/auth-actors.js';
import { createTestApp } from './utils/create-test-app.js';
import { MemoryTelegramLinkStore } from './utils/memory-telegram-link-store.js';
import { startTelegramStub } from './utils/telegram-stub.js';

const TOKEN = '123456789:e2e-test-token-abcdefghijklmnopqrstu';
const SECRET = 'e2e-telegram-webhook-secret-0123';
const BOT = 'ShieldTestBot';

/**
 * M7-T8: Telegram platform bot + chat linking (D2/D12/D13 answered 2026-11-20). Real Postgres;
 * the Bot API is a local stub that fails on unexpected requests; link codes live in memory.
 */
describe('Telegram alert linking (e2e)', () => {
  let app: INestApplication<App>;
  let stub: Awaited<ReturnType<typeof startTelegramStub>>;
  const store = new MemoryTelegramLinkStore();
  let actors: ReturnType<typeof createAuthActors>;
  let owner: Actor;
  let moderator: Actor;
  let starter: Actor;
  let outsider: Actor;
  let superAdmin: Actor;
  let nextUpdateId = 1;

  const http = () => request(app.getHttpServer());
  const base = (ws: string) => `/api/workspaces/${ws}/alerts/telegram`;
  const link = (cookie: string, ws: string) =>
    http()
      .post(`${base(ws)}/link`)
      .set('Cookie', cookie);
  const codeOf = (url: string) => new URL(url).searchParams.get('start')!;
  const newCode = async (ws = owner.workspaceId) =>
    codeOf((await link(owner.cookie, ws).expect(201)).body.url);
  const webhook = (body: object, secret: string | null = SECRET) => {
    const req = http().post('/api/telegram/webhook');
    if (secret !== null) req.set('X-Telegram-Bot-Api-Secret-Token', secret);
    return req.send(body);
  };
  const start = (
    chatId: number,
    text: string,
    chat: Record<string, unknown> = { type: 'private', first_name: 'Rahim' },
  ) => ({
    update_id: nextUpdateId++,
    message: {
      message_id: 1,
      date: 1_790_000_000,
      chat: { id: chatId, ...chat },
      from: { id: 42, is_bot: false, first_name: 'Rahim' },
      text,
    },
  });
  const chatsOf = (ws: string) =>
    actors.db
      .select()
      .from(telegramChats)
      .where(eq(telegramChats.workspaceId, ws));
  const settings = async (cookie: string, ws: string) =>
    (
      await http()
        .get(`/api/workspaces/${ws}/alerts/settings`)
        .set('Cookie', cookie)
        .expect(200)
    ).body as {
      telegram: {
        configured: boolean;
        chats: { id: string; title: string; type: string }[];
      };
    };

  beforeAll(async () => {
    stub = await startTelegramStub(TOKEN);
    app = await createTestApp((b) =>
      b
        .overrideProvider(TELEGRAM_CONFIG)
        .useValue({
          botToken: TOKEN,
          botUsername: BOT,
          webhookSecret: SECRET,
          apiBaseUrl: stub.url,
        })
        .overrideProvider(TelegramLinkStore)
        .useValue(store),
    );
    actors = createAuthActors(app);
    owner = await actors.signUp('m7t8-owner');
    moderator = await actors.signUp('m7t8-mod');
    starter = await actors.signUp('m7t8-starter', { trial: true });
    outsider = await actors.signUp('m7t8-outsider');
    superAdmin = await actors.signUpSuperAdmin('m7t8-super');
    await actors.addMember(owner.workspaceId, moderator.id, 'moderator');
    await actors.activatePlan(owner, 'growth');
  });

  afterEach(() => {
    expect(stub.unexpected).toEqual([]);
    stub.sent.length = 0;
  });

  afterAll(async () => {
    await actors?.cleanup();
    await app?.close();
    await stub?.close();
  });

  it('link → /start <code> saves the private chat, replies en + bn, code is one-time', async () => {
    const res = await link(owner.cookie, owner.workspaceId).expect(201);
    expect(res.body.url).toMatch(
      new RegExp(`^https://t\\.me/${BOT}\\?start=[A-Za-z0-9_-]{32}$`),
    );
    expect(res.body.groupUrl).toBe(
      res.body.url.replace('?start=', '?startgroup='),
    );
    const ttl = new Date(res.body.expiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(14 * 60_000);
    expect(ttl).toBeLessThanOrEqual(15 * 60_000);
    expect(store.ttls.at(-1)).toBe(900);
    const code = codeOf(res.body.url);

    await webhook(start(1001, `/start ${code}`)).expect(200);
    const [chat] = await chatsOf(owner.workspaceId);
    expect(chat).toMatchObject({
      telegramChatId: 1001,
      title: 'Rahim',
      type: 'private',
      linkedByUserId: owner.id,
    });
    expect(stub.sent).toHaveLength(1);
    expect(stub.sent[0]!.chatId).toBe(1001);
    expect(stub.sent[0]!.text).toContain('this chat is now linked');
    expect(stub.sent[0]!.text).toContain('যুক্ত হয়েছে');
    expect(stub.sent[0]!.text).not.toContain(code);
    expect(stub.sent[0]!.text).not.toContain(owner.workspaceId);

    // Reused code: note, nothing new saved.
    await webhook(start(1002, `/start ${code}`)).expect(200);
    expect(stub.sent[1]).toEqual({
      chatId: 1002,
      text: TELEGRAM_BOT_REPLIES.invalidCode,
    });
    expect(await chatsOf(owner.workspaceId)).toHaveLength(1);

    const view = await settings(moderator.cookie, owner.workspaceId);
    expect(view.telegram).toMatchObject({
      configured: true,
      chats: [{ id: chat!.id, title: 'Rahim', type: 'private' }],
    });
  });

  it('group: /start@bot <code> links the group; relinking the same chat updates it', async () => {
    const group = { type: 'supergroup', title: 'Shop team' };
    await webhook(
      start(-100777, `/start@${BOT} ${await newCode()}`, group),
    ).expect(200);
    await webhook(
      start(-100777, `/start ${await newCode()}`, {
        ...group,
        title: 'Shop team BD',
      }),
    ).expect(200);
    const rows = (await chatsOf(owner.workspaceId)).filter(
      (c) => c.telegramChatId === -100777,
    );
    expect(rows).toEqual([
      expect.objectContaining({ title: 'Shop team BD', type: 'supergroup' }),
    ]);
    expect(stub.sent.map((m) => m.chatId)).toEqual([-100777, -100777]);
  });

  it('expired code and /start without a code get the note', async () => {
    const code = await newCode();
    store.expire(code);
    await webhook(start(3001, `/start ${code}`)).expect(200);
    await webhook(start(3001, '/start')).expect(200);
    expect(stub.sent).toEqual([
      { chatId: 3001, text: TELEGRAM_BOT_REPLIES.invalidCode },
      { chatId: 3001, text: TELEGRAM_BOT_REPLIES.invalidCode },
    ]);
    expect(
      (await chatsOf(owner.workspaceId)).some((c) => c.telegramChatId === 3001),
    ).toBe(false);
  });

  it('ignores other updates with 200; bad or missing secret 401', async () => {
    const code = await newCode();
    await webhook(start(2001, `/start@OtherBot ${code}`)).expect(200);
    await webhook(start(2001, 'hello')).expect(200);
    await webhook({ update_id: nextUpdateId++, edited_message: {} }).expect(
      200,
    );
    await webhook({
      update_id: nextUpdateId++,
      channel_post: { chat: { id: -1009, type: 'channel' }, text: '/start' },
    }).expect(200);
    await webhook(
      start(2001, `/start ${code}`),
      'wrong-secret-0123456789',
    ).expect(401);
    await webhook(start(2001, `/start ${code}`), null).expect(401);
    expect(stub.sent).toEqual([]);
    expect(
      (await chatsOf(owner.workspaceId)).some((c) => c.telegramChatId === 2001),
    ).toBe(false);
    // The code survived all of that.
    await webhook(start(2001, `/start ${code}`)).expect(200);
    expect(stub.sent[0]!.text).toContain('this chat is now linked');
  });

  it('a 4th chat is refused (bot note + 409 on new links); removing one frees a slot', async () => {
    const ws = owner.workspaceId;
    expect(await chatsOf(ws)).toHaveLength(3);
    const res = await link(owner.cookie, ws).expect(409);
    expect(res.body).toMatchObject({
      code: 'TELEGRAM_CHAT_LIMIT',
      details: { max: 3 },
    });

    const [first] = await chatsOf(ws);
    await http()
      .delete(`${base(ws)}/chats/${first!.id}`)
      .set('Cookie', moderator.cookie)
      .expect(403);
    await http()
      .delete(`${base(ws)}/chats/${first!.id}`)
      .set('Cookie', owner.cookie)
      .expect(204);
    await http()
      .delete(`${base(ws)}/chats/${first!.id}`)
      .set('Cookie', owner.cookie)
      .expect(404);
    await http()
      .delete(`${base(ws)}/chats/not-a-uuid`)
      .set('Cookie', owner.cookie)
      .expect(400);

    // Two codes made with one free slot: the second hits the limit in the transaction.
    const a = await newCode();
    const b = await newCode();
    await webhook(start(4001, `/start ${a}`)).expect(200);
    await webhook(start(4002, `/start ${b}`)).expect(200);
    expect(stub.sent).toEqual([
      expect.objectContaining({ chatId: 4001 }),
      { chatId: 4002, text: TELEGRAM_BOT_REPLIES.limitReached },
    ]);
    expect(await chatsOf(ws)).toHaveLength(3);
  });

  it('access: Starter 409, moderator 403, non-member 404, foreign chat 404, impersonated owner may link (D2)', async () => {
    const res = await link(starter.cookie, starter.workspaceId).expect(409);
    expect(res.body).toMatchObject({
      code: 'PLAN_FEATURE_UNAVAILABLE',
      details: { feature: 'messengerAlerts' },
    });
    await link(moderator.cookie, owner.workspaceId).expect(403);
    await link(outsider.cookie, owner.workspaceId).expect(404);
    const [chat] = await chatsOf(owner.workspaceId);
    await http()
      .delete(`${base(owner.workspaceId)}/chats/${chat!.id}`)
      .set('Cookie', outsider.cookie)
      .expect(404);
    // The outsider's own workspace can't reach the owner's chat row.
    await http()
      .delete(`${base(outsider.workspaceId)}/chats/${chat!.id}`)
      .set('Cookie', outsider.cookie)
      .expect(404);
    expect(await chatsOf(owner.workspaceId)).toHaveLength(3);

    const cookie = await actors.signIn(owner.email);
    await actors.patchStoredSession(cookie, {
      impersonatedBy: superAdmin.id,
      activeOrganizationId: owner.workspaceId,
    });
    await http()
      .delete(`${base(owner.workspaceId)}/chats/${chat!.id}`)
      .set('Cookie', cookie)
      .expect(204);
    await link(cookie, owner.workspaceId).expect(201);
  });
});
