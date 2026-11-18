import {
  Body,
  Controller,
  HttpCode,
  type INestApplication,
  Post,
} from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { Public } from '../src/auth/decorators/public.decorator.js';
import {
  META_WEBHOOK_CONFIG,
  type MetaWebhookConfig,
} from '../src/webhooks/meta-webhook.config.js';
import { metaWebhookSignature } from '../src/webhooks/meta-webhook-signature.js';
import { createAuthActors } from './utils/auth-actors.js';
import { createTestApp } from './utils/create-test-app.js';

const PATH = '/api/webhooks/meta';
const SECRET = 'e2e-meta-app-secret-0123456789abcdef';
const VERIFY_TOKEN = 'e2e-verify-token-0123456789abcdef';

/** A compact FB `feed` payload as Meta sends it (no whitespace), and its signature. */
const PAYLOAD = JSON.stringify({
  object: 'page',
  entry: [
    {
      id: '101',
      time: 1763480000,
      changes: [
        {
          field: 'feed',
          value: {
            item: 'comment',
            verb: 'add',
            comment_id: '101_202_303',
            message: 'bKash 01700000000',
          },
        },
      ],
    },
  ],
});
const SIGNATURE = metaWebhookSignature(PAYLOAD, SECRET);

/** Test-only JSON route: proves the Better Auth integration still parses JSON elsewhere. */
@Public()
@Controller('test/webhook-echo')
class EchoController {
  @Post()
  @HttpCode(200)
  echo(@Body() body: Record<string, unknown>): Record<string, unknown> {
    return { body };
  }
}

/**
 * M4-T3: Meta webhook verify handshake + `X-Hub-Signature-256` guard on the raw body (Module 4 D1).
 * `enabled` overrides `META_WEBHOOK_CONFIG` (no META_* vars in the e2e env); `disabled` runs with the
 * real env (both secrets unset → 503).
 */
describe('Meta webhook verify + signature (e2e)', () => {
  let enabled: INestApplication<App>;
  let disabled: INestApplication<App>;
  let actors: ReturnType<typeof createAuthActors>;
  const config: MetaWebhookConfig = {
    verifyToken: VERIFY_TOKEN,
    appSecret: SECRET,
  };

  const http = () => request(enabled.getHttpServer());
  const verifyQuery = (overrides: Record<string, string> = {}) => ({
    'hub.mode': 'subscribe',
    'hub.verify_token': VERIFY_TOKEN,
    'hub.challenge': '1158201444',
    ...overrides,
  });
  const post = (body: string | Buffer, signature?: string) => {
    const req = http()
      .post(PATH)
      .set('Content-Type', 'application/json')
      .send(body);
    return signature ? req.set('X-Hub-Signature-256', signature) : req;
  };

  beforeAll(async () => {
    enabled = await createTestApp(
      (builder) =>
        builder.overrideProvider(META_WEBHOOK_CONFIG).useValue(config),
      [EchoController],
    );
    disabled = await createTestApp();
    actors = createAuthActors(enabled);
  });

  afterAll(async () => {
    await actors?.cleanup();
    await enabled?.close();
    await disabled?.close();
  });

  describe('GET verify handshake', () => {
    it('echoes hub.challenge as text/plain for subscribe + the right token', async () => {
      const res = await http().get(PATH).query(verifyQuery()).expect(200);
      expect(res.text).toBe('1158201444');
      expect(res.headers['content-type']).toMatch(/^text\/plain/);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('works with the dotted keys in a raw query string (no 400 from the global pipe)', async () => {
      const res = await http()
        .get(
          `${PATH}?hub.mode=subscribe&hub.challenge=42&hub.verify_token=${VERIFY_TOKEN}&extra=1`,
        )
        .expect(200);
      expect(res.text).toBe('42');
    });

    it.each([
      ['wrong token', { 'hub.verify_token': 'wrong-token-0123456789abcdef' }],
      ['wrong mode', { 'hub.mode': 'unsubscribe' }],
      ['empty challenge', { 'hub.challenge': '' }],
    ])('403 on %s', async (_label, overrides) => {
      const res = await http()
        .get(PATH)
        .query(verifyQuery(overrides))
        .expect(403);
      expect(res.body).toMatchObject({ statusCode: 403 });
      expect(JSON.stringify(res.body)).not.toContain(VERIFY_TOKEN);
    });

    it('403 without any query and without a challenge', async () => {
      await http().get(PATH).expect(403);
      await http()
        .get(PATH)
        .query({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN })
        .expect(403);
    });

    it('never echoes the verify token or challenge in an error body', async () => {
      const res = await http()
        .get(PATH)
        .query(verifyQuery({ 'hub.mode': 'x' }))
        .expect(403);
      expect(res.body.path).not.toContain(VERIFY_TOKEN);
      expect(res.body.path).not.toContain('1158201444');
    });

    it('503 when META_WEBHOOK_VERIFY_TOKEN is unset (the app still started)', async () => {
      const res = await request(disabled.getHttpServer())
        .get(PATH)
        .query(verifyQuery())
        .expect(503);
      expect(res.body).toMatchObject({ statusCode: 503 });
    });
  });

  describe('POST signature guard', () => {
    it('200 EVENT_RECEIVED for a correctly signed body, without a session', async () => {
      const res = await post(PAYLOAD, SIGNATURE).expect(200);
      expect(res.text).toBe('EVENT_RECEIVED');
    });

    it('checks the bytes whatever the content type', async () => {
      const form = 'a=1&b=2';
      await http()
        .post(PATH)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .set('X-Hub-Signature-256', metaWebhookSignature(form, SECRET))
        .send(form)
        .expect(200);
    });

    it('401 without the header', async () => {
      const res = await post(PAYLOAD).expect(401);
      expect(res.body).toMatchObject({ statusCode: 401 });
    });

    it('401 for a wrong or malformed signature', async () => {
      await post(
        PAYLOAD,
        metaWebhookSignature(PAYLOAD, 'another-secret-0123456789'),
      ).expect(401);
      await post(PAYLOAD, 'sha256=abc').expect(401);
      await post(PAYLOAD, SIGNATURE.replace('sha256=', 'sha1=')).expect(401);
    });

    it('401 when the JSON is re-serialised (proves the raw bytes are signed)', async () => {
      const pretty = JSON.stringify(JSON.parse(PAYLOAD), null, 2);
      await post(pretty, SIGNATURE).expect(401);
    });

    it('401 for an empty body signed as the payload', async () => {
      await http().post(PATH).set('X-Hub-Signature-256', SIGNATURE).expect(401);
    });

    it('413 with the normal error shape for a body over 1 MB', async () => {
      const big = Buffer.alloc(1024 * 1024 + 1, 0x61);
      const res = await post(big, metaWebhookSignature(big, SECRET)).expect(
        413,
      );
      expect(res.body).toMatchObject({ statusCode: 413, path: PATH });
    });

    it('503 when the Meta app vars are unset', async () => {
      await request(disabled.getHttpServer())
        .post(PATH)
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', SIGNATURE)
        .send(PAYLOAD)
        .expect(503);
    });
  });

  describe('other routes keep their body parsing', () => {
    it('Better Auth sign-up and sign-in still work', async () => {
      const owner = await actors.signUp('webhook-owner');
      const cookie = await actors.signIn(owner.email);
      const me = await http().get('/api/me').set('Cookie', cookie);
      expect(me.status).toBe(200);
    });

    it('a Nest JSON route still gets a parsed body', async () => {
      const res = await http()
        .post('/api/test/webhook-echo')
        .send({ hello: 'world' })
        .expect(200);
      expect(res.body).toEqual({ body: { hello: 'world' } });
    });
  });
});
