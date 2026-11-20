import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { moderationPolicies } from '../src/db/schema/index.js';
import { type Actor, createAuthActors } from './utils/auth-actors.js';
import { createTestApp } from './utils/create-test-app.js';

const EN = 'Thanks for asking! Please message our Page.';
const BN = 'জিজ্ঞাসার জন্য ধন্যবাদ! আমাদের পেজে মেসেজ দিন।';

/**
 * M5-T8: workspace moderation policy API (D3/D4/D5/D6/D8 answered 2026-11-19). Real Postgres;
 * no Meta or LLM call is involved (the app has no fakes for them, so any call would fail).
 */
describe('Moderation policy API (e2e)', () => {
  let app: INestApplication<App>;
  let actors: ReturnType<typeof createAuthActors>;
  let owner: Actor;
  let other: Actor;
  let growth: Actor;
  let moderator: Actor;
  let wsAdmin: Actor;
  let outsider: Actor;
  let superAdmin: Actor;

  const http = () => request(app.getHttpServer());
  const path = (workspaceId: string) =>
    `/api/workspaces/${workspaceId}/moderation/policy`;
  const get = (cookie: string, workspaceId: string) =>
    http().get(path(workspaceId)).set('Cookie', cookie);
  const patch = (cookie: string, workspaceId: string, body: unknown) =>
    http()
      .patch(path(workspaceId))
      .set('Cookie', cookie)
      .send(body as object);

  const storedRow = async (workspaceId: string) => {
    const [row] = await actors.db
      .select()
      .from(moderationPolicies)
      .where(eq(moderationPolicies.workspaceId, workspaceId));
    return row;
  };
  const resetPolicy = (workspaceId: string) =>
    actors.db
      .delete(moderationPolicies)
      .where(eq(moderationPolicies.workspaceId, workspaceId));

  beforeAll(async () => {
    app = await createTestApp();
    actors = createAuthActors(app);
    owner = await actors.signUp('m5t8-owner');
    other = await actors.signUp('m5t8-other');
    growth = await actors.signUp('m5t8-growth');
    moderator = await actors.signUp('m5t8-mod');
    wsAdmin = await actors.signUp('m5t8-admin');
    outsider = await actors.signUp('m5t8-outsider');
    superAdmin = await actors.signUpSuperAdmin('m5t8-super');
    await actors.addMember(owner.workspaceId, moderator.id, 'moderator');
    await actors.addMember(owner.workspaceId, wsAdmin.id, 'admin');
    // PW-T5: flags come from the account's live subscription (sign-up = Starter trial).
    await actors.activatePlan(growth, 'growth');
  });

  afterAll(async () => {
    await actors?.cleanup();
    await app?.close();
  });

  describe('GET (lazy defaults, D3/D4/D6/D8)', () => {
    it('creates the row with the defaults on first read', async () => {
      expect(await storedRow(owner.workspaceId)).toBeUndefined();
      const res = await get(owner.cookie, owner.workspaceId).expect(200);
      expect(res.body).toEqual({
        workspaceId: owner.workspaceId,
        mode: 'AUTO',
        confidenceThreshold: 0.8,
        aiContextLevel: 'comment_only',
        categories: {
          SAFE_INQUIRY: {
            action: 'NONE',
            autoReply: false,
            replyEn: null,
            replyBn: null,
          },
          COMPETITOR_POACH: {
            action: 'HIDE',
            autoReply: false,
            replyEn: null,
            replyBn: null,
          },
          SCAM_PHISHING: {
            action: 'HIDE',
            autoReply: false,
            replyEn: null,
            replyBn: null,
          },
          SPAM_IRRELEVANT: {
            action: 'HIDE',
            autoReply: false,
            replyEn: null,
            replyBn: null,
          },
          ABUSIVE_TOXIC: {
            action: 'HIDE',
            autoReply: false,
            replyEn: null,
            replyBn: null,
          },
        },
        autoReplyAvailable: false,
        rules: {
          blockedKeywords: [],
          blockUrls: false,
          blockPhoneNumbers: false,
          allowedDomains: [],
          actions: { keyword: 'HIDE', url: 'HIDE', phone: 'HIDE' },
        },
        // Sign-up starts no plan (PR-T3): every flag off.
        keywordRulesAvailable: false,
        urlPhoneRulesAvailable: false,
        updatedAt: expect.any(String),
      });
      expect(await storedRow(owner.workspaceId)).toBeDefined();
      // A second read returns the same row.
      const again = await get(owner.cookie, owner.workspaceId).expect(200);
      expect(again.body.updatedAt).toBe(res.body.updatedAt);
    });

    it('autoReplyAvailable follows the live plan (Growth on, Starter trial off)', async () => {
      expect(
        (await get(growth.cookie, growth.workspaceId).expect(200)).body
          .autoReplyAvailable,
      ).toBe(true);
      expect(
        (await get(other.cookie, other.workspaceId).expect(200)).body
          .autoReplyAvailable,
      ).toBe(false);
    });

    it('no live plan (Growth term ended, or no billing account) → flags off, PATCH on → 409', async () => {
      const ended = await actors.signUp('pwt5-flags-ended');
      await actors.activatePlan(ended, 'growth');
      expect(
        (await get(ended.cookie, ended.workspaceId).expect(200)).body
          .autoReplyAvailable,
      ).toBe(true);
      await actors.expirePlan(ended);
      expect(
        (await get(ended.cookie, ended.workspaceId).expect(200)).body
          .autoReplyAvailable,
      ).toBe(false);
      const res = await patch(ended.cookie, ended.workspaceId, {
        categories: {
          SCAM_PHISHING: { autoReply: true, replyEn: EN, replyBn: BN },
        },
      }).expect(409);
      expect(res.body.code).toBe('PLAN_FEATURE_UNAVAILABLE');

      const orphan = await actors.signUp('pwt5-flags-orphan');
      await actors.activatePlan(orphan, 'growth');
      await actors.removeBilling(orphan);
      expect(
        (await get(orphan.cookie, orphan.workspaceId).expect(200)).body
          .autoReplyAvailable,
      ).toBe(false);
    });
  });

  describe('PATCH round-trip', () => {
    afterAll(() => resetPolicy(growth.workspaceId));

    it('saves a partial body and GET returns it', async () => {
      const res = await patch(growth.cookie, growth.workspaceId, {
        mode: 'REVIEW',
        confidenceThreshold: 0.875,
        aiContextLevel: 'post_caption',
        categories: {
          SAFE_INQUIRY: { autoReply: true, replyEn: `  ${EN} `, replyBn: BN },
          SCAM_PHISHING: { action: 'DELETE' },
        },
      }).expect(200);
      expect(res.body).toMatchObject({
        changed: true,
        mode: 'REVIEW',
        confidenceThreshold: 0.875,
        aiContextLevel: 'post_caption',
        autoReplyAvailable: true,
        categories: {
          SAFE_INQUIRY: {
            action: 'NONE',
            autoReply: true,
            replyEn: EN,
            replyBn: BN,
          },
          SCAM_PHISHING: { action: 'DELETE', autoReply: false },
          ABUSIVE_TOXIC: { action: 'HIDE' },
        },
      });
      const read = await get(growth.cookie, growth.workspaceId).expect(200);
      const { changed: _changed, ...saved } = res.body;
      expect(read.body).toEqual(saved);
      const row = await storedRow(growth.workspaceId);
      expect(row).toMatchObject({
        mode: 'REVIEW',
        confidenceThreshold: 0.875,
        safeInquiryReplyEn: EN,
        scamPhishingAction: 'DELETE',
      });
    });

    it('same values = no-op: changed false, updated_at kept', async () => {
      const before = await storedRow(growth.workspaceId);
      const res = await patch(growth.cookie, growth.workspaceId, {
        mode: 'REVIEW',
        categories: {
          SCAM_PHISHING: { action: 'DELETE' },
          SAFE_INQUIRY: { replyEn: EN },
        },
      }).expect(200);
      expect(res.body.changed).toBe(false);
      expect(res.body.updatedAt).toBe(before!.updatedAt.toISOString());
      expect((await storedRow(growth.workspaceId))!.updatedAt).toEqual(
        before!.updatedAt,
      );
    });

    it('a real change bumps updated_at; switching off keeps the texts', async () => {
      const before = await storedRow(growth.workspaceId);
      const res = await patch(growth.cookie, growth.workspaceId, {
        categories: { SAFE_INQUIRY: { autoReply: false } },
      }).expect(200);
      expect(res.body.changed).toBe(true);
      expect(res.body.categories.SAFE_INQUIRY).toEqual({
        action: 'NONE',
        autoReply: false,
        replyEn: EN,
        replyBn: BN,
      });
      expect(new Date(res.body.updatedAt).getTime()).toBeGreaterThan(
        before!.updatedAt.getTime(),
      );
    });

    it('PATCH on a workspace without a row creates it first', async () => {
      await resetPolicy(other.workspaceId);
      const res = await patch(other.cookie, other.workspaceId, {
        aiContextLevel: 'page_name',
      }).expect(200);
      expect(res.body).toMatchObject({
        changed: true,
        aiContextLevel: 'page_name',
        mode: 'AUTO',
      });
      await resetPolicy(other.workspaceId);
    });
  });

  describe('validation (400)', () => {
    it.each([
      ['empty body', {}],
      ['empty category', { categories: { SAFE_INQUIRY: {} } }],
      [
        'unknown field',
        { workspaceId: '019a0000-0000-7000-8000-000000000001' },
      ],
      ['bad mode', { mode: 'auto' }],
      ['threshold below 0.5', { confidenceThreshold: 0.3 }],
      ['threshold above 1', { confidenceThreshold: 1.5 }],
      ['threshold as string', { confidenceThreshold: '0.9' }],
      ['threshold with 4 decimals', { confidenceThreshold: 0.8125 }],
      ['bad context level', { aiContextLevel: 'all' }],
      ['unknown category', { categories: { OTHER: { action: 'HIDE' } } }],
      ['bad action', { categories: { SCAM_PHISHING: { action: 'BAN' } } }],
      ['blank text', { categories: { SCAM_PHISHING: { replyEn: '   ' } } }],
      [
        'text too long',
        { categories: { SCAM_PHISHING: { replyBn: 'x'.repeat(501) } } },
      ],
      ['null switch', { categories: { SCAM_PHISHING: { autoReply: null } } }],
    ])('%s', async (_name, body) => {
      const before = await storedRow(growth.workspaceId);
      const res = await patch(growth.cookie, growth.workspaceId, body).expect(
        400,
      );
      expect(res.body.statusCode).toBe(400);
      expect(await storedRow(growth.workspaceId)).toEqual(before);
    });

    it('auto-reply on without both texts → 400 AUTO_REPLY_TEXTS_REQUIRED', async () => {
      const res = await patch(growth.cookie, growth.workspaceId, {
        categories: { COMPETITOR_POACH: { autoReply: true, replyEn: EN } },
      }).expect(400);
      expect(res.body).toMatchObject({
        code: 'AUTO_REPLY_TEXTS_REQUIRED',
        details: { category: 'COMPETITOR_POACH' },
      });
      expect(
        (await storedRow(growth.workspaceId))?.competitorPoachAutoReply ??
          false,
      ).toBe(false);
    });

    it('accepts 500-char texts and the range ends', async () => {
      await patch(growth.cookie, growth.workspaceId, {
        confidenceThreshold: 0.5,
        categories: {
          SPAM_IRRELEVANT: {
            replyEn: 'x'.repeat(500),
            replyBn: 'ক'.repeat(500),
          },
        },
      }).expect(200);
      await patch(growth.cookie, growth.workspaceId, {
        confidenceThreshold: 1,
      }).expect(200);
      await resetPolicy(growth.workspaceId);
    });
  });

  describe('plan feature (D6)', () => {
    it('409 PLAN_FEATURE_UNAVAILABLE on a plan without autoReplyTemplates (Starter trial)', async () => {
      const res = await patch(owner.cookie, owner.workspaceId, {
        categories: {
          SAFE_INQUIRY: { autoReply: true, replyEn: EN, replyBn: BN },
        },
      }).expect(409);
      expect(res.body).toMatchObject({
        statusCode: 409,
        code: 'PLAN_FEATURE_UNAVAILABLE',
        details: { feature: 'autoReplyTemplates' },
      });
      expect((await storedRow(owner.workspaceId))!.safeInquiryAutoReply).toBe(
        false,
      );
    });

    it('texts may still be saved with the switch off on Starter', async () => {
      const res = await patch(owner.cookie, owner.workspaceId, {
        categories: { SAFE_INQUIRY: { replyEn: EN, replyBn: BN } },
      }).expect(200);
      expect(res.body.categories.SAFE_INQUIRY).toEqual({
        action: 'NONE',
        autoReply: false,
        replyEn: EN,
        replyBn: BN,
      });
      await resetPolicy(owner.workspaceId);
    });
  });

  describe('static rules (M6-T1; D2/D4/D5/D6 answered 2026-11-20)', () => {
    afterAll(async () => {
      await resetPolicy(growth.workspaceId);
      await resetPolicy(owner.workspaceId);
    });

    it('round trip: normalised + de-duplicated keywords, domains, switches, actions', async () => {
      const res = await patch(growth.cookie, growth.workspaceId, {
        rules: {
          blockedKeywords: [
            '  Free   BKASH ',
            'free bkash',
            'ＢＫＡＳＨ',
            'বিকাশ  নম্বর',
          ],
          blockUrls: true,
          blockPhoneNumbers: true,
          allowedDomains: ['WWW.Shop.Example.com', 'shop.example.com'],
          actions: { phone: 'DELETE' },
        },
      }).expect(200);
      expect(res.body).toMatchObject({
        changed: true,
        keywordRulesAvailable: true,
        urlPhoneRulesAvailable: true,
        rules: {
          blockedKeywords: ['free bkash', 'bkash', 'বিকাশ নম্বর'],
          blockUrls: true,
          blockPhoneNumbers: true,
          allowedDomains: ['shop.example.com'],
          actions: { keyword: 'HIDE', url: 'HIDE', phone: 'DELETE' },
        },
      });
      const { changed: _changed, ...saved } = res.body;
      expect(
        (await get(growth.cookie, growth.workspaceId).expect(200)).body,
      ).toEqual(saved);
      expect(await storedRow(growth.workspaceId)).toMatchObject({
        blockedKeywords: ['free bkash', 'bkash', 'বিকাশ নম্বর'],
        phoneRuleAction: 'DELETE',
      });
    });

    it('the same lists in another spelling = no-op (updated_at kept)', async () => {
      const before = await storedRow(growth.workspaceId);
      const res = await patch(growth.cookie, growth.workspaceId, {
        rules: {
          blockedKeywords: ['FREE BKASH', 'bkash', 'বিকাশ নম্বর'],
          allowedDomains: ['shop.example.com.'],
        },
      }).expect(200);
      expect(res.body.changed).toBe(false);
      expect((await storedRow(growth.workspaceId))!.updatedAt).toEqual(
        before!.updatedAt,
      );
    });

    it.each([
      [
        'blank keyword',
        { blockedKeywords: ['ok', '  '] },
        'BLOCKED_KEYWORD_INVALID',
      ],
      [
        'keyword > 50',
        { blockedKeywords: ['ক'.repeat(51)] },
        'BLOCKED_KEYWORD_INVALID',
      ],
      [
        '201 keywords',
        { blockedKeywords: Array.from({ length: 201 }, (_, i) => `k${i}`) },
        'BLOCKED_KEYWORDS_LIMIT',
      ],
      [
        'URL as a domain',
        { allowedDomains: ['https://shop.com/x'] },
        'ALLOWED_DOMAIN_INVALID',
      ],
      [
        '21 domains',
        { allowedDomains: Array.from({ length: 21 }, (_, i) => `d${i}.com`) },
        'ALLOWED_DOMAINS_LIMIT',
      ],
    ])('400 %s → code %s', async (_name, rules, code) => {
      const before = await storedRow(growth.workspaceId);
      const res = await patch(growth.cookie, growth.workspaceId, {
        rules,
      }).expect(400);
      expect(res.body.code).toBe(code);
      expect(await storedRow(growth.workspaceId)).toEqual(before);
    });

    it.each([
      ['keywords as a string', { blockedKeywords: 'bkash' }],
      ['a number keyword', { blockedKeywords: [5] }],
      ['null switch', { blockUrls: null }],
      ['action NONE', { actions: { url: 'NONE' } }],
      ['unknown rule field', { regex: ['.*'] }],
      ['empty rules', {}],
    ])('400 %s', async (_name, rules) => {
      await patch(growth.cookie, growth.workspaceId, { rules }).expect(400);
    });

    it('Starter: keywords → 409 customBlocklist; URL / phone, domains and actions allowed', async () => {
      const starter = await actors.signUp('m6t1-starter');
      await actors.activatePlan(starter, 'starter');
      const res = await patch(starter.cookie, starter.workspaceId, {
        rules: { blockedKeywords: ['bkash'] },
      }).expect(409);
      expect(res.body).toMatchObject({
        code: 'PLAN_FEATURE_UNAVAILABLE',
        details: { feature: 'customBlocklist' },
      });
      const ok = await patch(starter.cookie, starter.workspaceId, {
        rules: {
          blockUrls: true,
          blockPhoneNumbers: true,
          allowedDomains: ['myshop.com.bd'],
          actions: { url: 'DELETE' },
        },
      }).expect(200);
      expect(ok.body.rules).toMatchObject({
        blockedKeywords: [],
        blockUrls: true,
        blockPhoneNumbers: true,
        allowedDomains: ['myshop.com.bd'],
        actions: { url: 'DELETE' },
      });
      expect(ok.body).toMatchObject({
        keywordRulesAvailable: false,
        urlPhoneRulesAvailable: true,
      });
      await resetPolicy(starter.workspaceId);
    });

    it('no live plan: switching URL / phone on → 409 autoHideScams; downgraded keywords can be removed', async () => {
      const lapsed = await actors.signUp('m6t1-lapsed');
      await actors.activatePlan(lapsed, 'growth');
      await patch(lapsed.cookie, lapsed.workspaceId, {
        rules: { blockedKeywords: ['a', 'b'] },
      }).expect(200);
      await actors.expirePlan(lapsed);
      const read = await get(lapsed.cookie, lapsed.workspaceId).expect(200);
      expect(read.body).toMatchObject({
        keywordRulesAvailable: false,
        urlPhoneRulesAvailable: false,
      });
      const res = await patch(lapsed.cookie, lapsed.workspaceId, {
        rules: { blockPhoneNumbers: true },
      }).expect(409);
      expect(res.body.details).toEqual({ feature: 'autoHideScams' });
      await patch(lapsed.cookie, lapsed.workspaceId, {
        rules: { blockedKeywords: ['b', 'c'] },
      }).expect(409);
      const removed = await patch(lapsed.cookie, lapsed.workspaceId, {
        rules: { blockedKeywords: ['b'] },
      }).expect(200);
      expect(removed.body.rules.blockedKeywords).toEqual(['b']);
      await resetPolicy(lapsed.workspaceId);
    });

    it('moderator 403; impersonated owner may edit rules; other workspaces untouched', async () => {
      const modCookie = await actors.signIn(moderator.email);
      await actors.patchStoredSession(modCookie, {
        activeOrganizationId: owner.workspaceId,
      });
      await patch(modCookie, owner.workspaceId, {
        rules: { blockUrls: false },
      }).expect(403);
      const cookie = await actors.signIn(owner.email);
      await actors.patchStoredSession(cookie, {
        impersonatedBy: superAdmin.id,
        activeOrganizationId: owner.workspaceId,
      });
      const res = await patch(cookie, owner.workspaceId, {
        rules: { blockUrls: false, actions: { keyword: 'DELETE' } },
      }).expect(200);
      expect(res.body.rules).toMatchObject({
        blockUrls: false,
        actions: { keyword: 'DELETE' },
      });
      await patch(growth.cookie, owner.workspaceId, {
        rules: { blockPhoneNumbers: false },
      }).expect(404);
      expect((await storedRow(growth.workspaceId))!.blockPhoneNumbers).toBe(
        true,
      );
    });
  });

  describe('roles + impersonation (D5)', () => {
    it('401 without a session', async () => {
      await http().get(path(owner.workspaceId)).expect(401);
      await http()
        .patch(path(owner.workspaceId))
        .send({ mode: 'REVIEW' })
        .expect(401);
    });

    it('403 for a moderator (GET + PATCH)', async () => {
      const cookie = await actors.signIn(moderator.email);
      await actors.patchStoredSession(cookie, {
        activeOrganizationId: owner.workspaceId,
      });
      await get(cookie, owner.workspaceId).expect(403);
      await patch(cookie, owner.workspaceId, { mode: 'REVIEW' }).expect(403);
      expect((await storedRow(owner.workspaceId))?.mode ?? 'AUTO').toBe('AUTO');
    });

    it('404 for a non-member and a malformed id', async () => {
      await get(outsider.cookie, owner.workspaceId).expect(404);
      await patch(outsider.cookie, owner.workspaceId, {
        mode: 'REVIEW',
      }).expect(404);
      await get(owner.cookie, 'not-a-uuid').expect(404);
      expect((await storedRow(owner.workspaceId))?.mode ?? 'AUTO').toBe('AUTO');
    });

    it('a workspace admin may read and edit', async () => {
      await get(wsAdmin.cookie, owner.workspaceId).expect(200);
      const res = await patch(wsAdmin.cookie, owner.workspaceId, {
        confidenceThreshold: 0.9,
      }).expect(200);
      expect(res.body.confidenceThreshold).toBe(0.9);
      await resetPolicy(owner.workspaceId);
    });

    it('an impersonated session may read and edit its workspace only', async () => {
      const cookie = await actors.signIn(owner.email);
      await actors.patchStoredSession(cookie, {
        impersonatedBy: superAdmin.id,
        activeOrganizationId: owner.workspaceId,
      });
      await get(cookie, owner.workspaceId).expect(200);
      const res = await patch(cookie, owner.workspaceId, {
        mode: 'REVIEW',
      }).expect(200);
      expect(res.body).toMatchObject({ changed: true, mode: 'REVIEW' });
      // Locked to the impersonated workspace, even where the user is a member.
      await actors.addMember(other.workspaceId, owner.id, 'admin');
      await get(cookie, other.workspaceId).expect(404);
      await patch(cookie, other.workspaceId, { mode: 'REVIEW' }).expect(404);
      await resetPolicy(owner.workspaceId);
    });
  });

  describe('tenant isolation', () => {
    it("one workspace's owner cannot read or change another's policy", async () => {
      await get(other.cookie, other.workspaceId).expect(200);
      const before = await storedRow(other.workspaceId);
      const read = await get(growth.cookie, other.workspaceId).expect(404);
      expect(read.body.message).toBe('Workspace not found');
      expect(JSON.stringify(read.body)).not.toContain('categories');
      await patch(growth.cookie, other.workspaceId, { mode: 'REVIEW' }).expect(
        404,
      );
      await patch(other.cookie, growth.workspaceId, { mode: 'REVIEW' }).expect(
        404,
      );
      expect(await storedRow(other.workspaceId)).toEqual(before);
    });

    it("editing one workspace's policy never touches another's", async () => {
      await patch(growth.cookie, growth.workspaceId, {
        categories: { ABUSIVE_TOXIC: { action: 'DELETE' } },
      }).expect(200);
      expect((await storedRow(growth.workspaceId))!.abusiveToxicAction).toBe(
        'DELETE',
      );
      expect((await storedRow(other.workspaceId))!.abusiveToxicAction).toBe(
        'HIDE',
      );
      const otherRead = await get(other.cookie, other.workspaceId).expect(200);
      expect(otherRead.body.workspaceId).toBe(other.workspaceId);
      expect(otherRead.body.categories.ABUSIVE_TOXIC.action).toBe('HIDE');
    });
  });
});
