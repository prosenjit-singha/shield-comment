import type { HttpException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { createEmailServiceFake } from '../../test/utils/fake-email.js';
import { MemoryOwnershipTransferStore } from '../../test/utils/memory-transfer-store.js';
import type { PasswordService } from '../auth/password.service.js';
import type { Database } from '../db/database.js';
import type { EmailService } from '../email/email.service.js';
import {
  billingMove,
  hashTransferCode,
  newTransferCode,
  OWNERSHIP_TRANSFER_CODES as CODES,
  OwnershipTransferService,
  transferCodeEmail,
  transferInputError,
  transferKeys,
} from './ownership-transfer.service.js';
import type { TeamService, TeamView } from './team.service.js';

const WS = '0192f5a4-7c3e-7a10-8b2c-3d4e5f6a7b8c';
const OWNER = { id: 'owner-1', email: 'owner@shop.bd' };
const TARGET = { id: 'member-2', userId: 'user-2' };
const APP_URL = 'http://app.localhost:5174';
const keys = transferKeys(WS, OWNER.id);

async function rejection(promise: Promise<unknown>) {
  const error = (await promise.then(
    () => expect.fail('expected a rejection'),
    (e: unknown) => e,
  )) as HttpException;
  return {
    status: error.getStatus(),
    code: (error.getResponse() as { code?: string }).code,
  };
}

function setup(options: { hash?: string | null } = {}) {
  const store = new MemoryOwnershipTransferStore();
  const email = createEmailServiceFake();
  const passwords = { verify: vi.fn().mockResolvedValue(false) };
  const view = { members: [] } as unknown as TeamView;
  const team = { team: vi.fn().mockResolvedValue(view) };
  // `select().from().where()` → the workspace name row.
  const where = vi.fn().mockResolvedValue([{ name: 'Shop & Co' }]);
  const db = { select: () => ({ from: () => ({ where }) }) };
  const service = new OwnershipTransferService(
    db as unknown as Database,
    store,
    passwords as unknown as PasswordService,
    email as unknown as EmailService,
    team as unknown as TeamService,
    { get: () => APP_URL } as unknown as ConfigService<never, true>,
  );
  const internals = service as unknown as {
    passwordHash: (userId: string) => Promise<string | null>;
    member: (ws: string, id: string) => Promise<typeof TARGET | undefined>;
    swap: (ws: string, owner: string, member: string) => Promise<void>;
  };
  vi.spyOn(internals, 'passwordHash').mockResolvedValue(
    options.hash === undefined ? null : options.hash,
  );
  vi.spyOn(internals, 'member').mockResolvedValue(TARGET);
  const swap = vi.spyOn(internals, 'swap').mockResolvedValue(undefined);
  return { service, store, email, passwords, team, swap, view, internals };
}

describe('transferInputError (body rules)', () => {
  it('code method needs a code; password method needs both equal fields', () => {
    expect(transferInputError('code', {})).toBe(CODES.codeRequired);
    expect(transferInputError('code', { code: '123456' })).toBeNull();
    expect(transferInputError('password', { code: '123456' })).toBe(
      CODES.passwordRequired,
    );
    expect(transferInputError('password', { password: 'a' })).toBe(
      CODES.passwordRequired,
    );
    expect(
      transferInputError('password', { password: 'a', passwordConfirm: 'b' }),
    ).toBe(CODES.passwordMismatch);
    expect(
      transferInputError('password', { password: 'a', passwordConfirm: 'a' }),
    ).toBeNull();
  });
});

describe('billingMove (M7-D19 a)', () => {
  const base = {
    account: 'owners' as const,
    hasOtherWorkspaces: false,
    targetAccount: 'none' as const,
  };
  it('moves the whole account when it pays for this workspace only', () => {
    expect(billingMove(base)).toEqual({
      move: true,
      deleteTargetAccount: false,
    });
    expect(billingMove({ ...base, targetAccount: 'empty' })).toEqual({
      move: true,
      deleteTargetAccount: true,
    });
  });
  it('refuses a target account in use and an account with other workspaces', () => {
    expect(billingMove({ ...base, targetAccount: 'in_use' })).toEqual({
      refusal: CODES.targetHasAccount,
    });
    expect(
      billingMove({
        ...base,
        hasOtherWorkspaces: true,
        targetAccount: 'in_use',
      }),
    ).toEqual({ refusal: CODES.accountHasOtherWorkspaces });
  });
  it('no account, or one the owner does not own: nothing moves', () => {
    for (const account of ['none', 'not_owners'] as const)
      expect(
        billingMove({ ...base, account, targetAccount: 'in_use' }),
      ).toEqual({ move: false, deleteTargetAccount: false });
  });
});

describe('codes + email', () => {
  it('6 digits; the hash is bound to the key and never the plain code', () => {
    for (let i = 0; i < 50; i += 1)
      expect(newTransferCode()).toMatch(/^\d{6}$/);
    const hash = hashTransferCode(keys.code, '123456');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashTransferCode(keys.code, '123456'));
    expect(hash).not.toBe(hashTransferCode(`${keys.code}x`, '123456'));
  });

  it('en + bn, the code and the escaped workspace name, no link', () => {
    const mail = transferCodeEmail('042917', 'Shop & Co', APP_URL);
    expect(mail.subject).toBe(
      'Your code to transfer workspace ownership · ওয়ার্কস্পেসের মালিকানা হস্তান্তরের কোড',
    );
    expect(mail.text.match(/042917/g)).toHaveLength(2);
    expect(mail.html).toContain('Shop &amp; Co');
    expect(mail.html).not.toContain('<a ');
  });
});

describe('OwnershipTransferService.sendCode', () => {
  it('stores the hash for 10 min, resets attempts, emails the owner; resend within 1 min → 429', async () => {
    const { service, store, email } = setup();
    await store.put(keys.attempts, '4', 600);
    email.expectSends(1);
    const now = new Date('2026-11-20T10:00:00Z');
    expect(await service.sendCode(WS, OWNER, now)).toEqual({
      expiresAt: new Date('2026-11-20T10:10:00Z'),
      resendAt: new Date('2026-11-20T10:01:00Z'),
    });
    const code = /: (\d{6})\n/.exec(email.sent[0]!.text)![1]!;
    expect(email.sent[0]!.to).toBe(OWNER.email);
    expect(await store.get(keys.code)).toBe(hashTransferCode(keys.code, code));
    const ttl = store.entries.get(keys.code)!.expiresAt - Date.now();
    expect(ttl).toBeGreaterThan(590_000);
    expect(ttl).toBeLessThanOrEqual(600_000);
    expect(await store.get(keys.attempts)).toBeNull();

    expect(await rejection(service.sendCode(WS, OWNER))).toEqual({
      status: 429,
      code: CODES.resendTooSoon,
    });
    expect(email.unexpected).toEqual([]);
  });

  it('email failure → 503, code and resend window cleared', async () => {
    const { service, store, email } = setup();
    email.failNext(new Error('down'));
    expect(await rejection(service.sendCode(WS, OWNER))).toEqual({
      status: 503,
      code: CODES.emailFailed,
    });
    expect(store.entries.size).toBe(0);
  });

  it('owner with a password → 409 TRANSFER_CODE_NOT_NEEDED', async () => {
    const { service } = setup({ hash: 'argon-hash' });
    expect(await service.method(OWNER.id)).toBe('password');
    expect(await rejection(service.sendCode(WS, OWNER))).toEqual({
      status: 409,
      code: CODES.codeNotNeeded,
    });
  });
});

describe('OwnershipTransferService.transfer', () => {
  const body = (code: string) => ({ memberId: TARGET.id, code });

  it('code: missing → expired 403, wrong → 403, right → swap + keys cleared + team view', async () => {
    const { service, store, swap, view } = setup();
    expect(
      await rejection(service.transfer(WS, OWNER.id, body('123456'))),
    ).toEqual({
      status: 403,
      code: CODES.codeExpired,
    });
    await store.put(keys.code, hashTransferCode(keys.code, '123456'), 600);
    expect(
      await rejection(service.transfer(WS, OWNER.id, body('654321'))),
    ).toEqual({
      status: 403,
      code: CODES.codeInvalid,
    });
    expect(swap).not.toHaveBeenCalled();
    expect(await service.transfer(WS, OWNER.id, body('123456'))).toBe(view);
    expect(swap).toHaveBeenCalledWith(WS, OWNER.id, TARGET.id);
    expect(await store.get(keys.code)).toBeNull();
    expect(await store.get(keys.attempts)).toBeNull();
  });

  it('6th attempt in 10 min → 429 and the code is dropped (even the right one)', async () => {
    const { service, store } = setup();
    await store.put(keys.code, hashTransferCode(keys.code, '123456'), 600);
    for (let i = 0; i < 5; i += 1)
      expect(
        (await rejection(service.transfer(WS, OWNER.id, body('000000')))).code,
      ).toBe(CODES.codeInvalid);
    expect(
      await rejection(service.transfer(WS, OWNER.id, body('123456'))),
    ).toEqual({
      status: 429,
      code: CODES.tooManyAttempts,
    });
    expect(await store.get(keys.code)).toBeNull();
  });

  it('password: verified with the stored hash; wrong → 403 (not 401)', async () => {
    const { service, passwords, swap } = setup({ hash: 'argon-hash' });
    const input = {
      memberId: TARGET.id,
      password: 'secret-pw',
      passwordConfirm: 'secret-pw',
    };
    expect(await rejection(service.transfer(WS, OWNER.id, input))).toEqual({
      status: 403,
      code: CODES.passwordInvalid,
    });
    expect(passwords.verify).toHaveBeenCalledWith('argon-hash', 'secret-pw');
    passwords.verify.mockResolvedValue(true);
    await service.transfer(WS, OWNER.id, input);
    expect(swap).toHaveBeenCalledOnce();
  });

  it('target: not a member → 404, the owner → 400, before any attempt is counted', async () => {
    const { service, internals, store } = setup();
    vi.spyOn(internals, 'member').mockResolvedValueOnce(undefined);
    expect(await rejection(service.transfer(WS, OWNER.id, body('1')))).toEqual({
      status: 404,
      code: CODES.targetNotFound,
    });
    vi.spyOn(internals, 'member').mockResolvedValueOnce({
      id: 'member-1',
      userId: OWNER.id,
    });
    expect(await rejection(service.transfer(WS, OWNER.id, body('1')))).toEqual({
      status: 400,
      code: CODES.targetIsSelf,
    });
    expect(store.entries.size).toBe(0);
  });
});
