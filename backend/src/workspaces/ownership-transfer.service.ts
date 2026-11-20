import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, eq, isNotNull, ne, or, sql } from 'drizzle-orm';
import { DEFAULT_CLIENT_APP_URL } from '../admin/admin-impersonation.service.js';
import { IMPERSONATION_READ_ONLY } from '../auth/workspace-invites.js';
import { PasswordService } from '../auth/password.service.js';
import type { EnvironmentVariables } from '../config/env.validation.js';
import type { Database } from '../db/database.js';
import {
  accounts,
  billingAccounts,
  promotionRedemptions,
  paymentTransactions,
  subscriptionAuditLogs,
  subscriptions,
  wallets,
  workspaceMembers,
  workspaces,
} from '../db/schema/index.js';
import { bilingualEmail, type EmailContent } from '../email/bilingual-email.js';
import { EmailService } from '../email/email.service.js';
import { OwnershipTransferStore } from './ownership-transfer.store.js';
import { TeamService, type TeamView } from './team.service.js';

/** D11: owners with a password confirm it twice; Google-only owners get an emailed code. */
export type TransferMethod = 'password' | 'code';

export const TRANSFER_CODE_TTL_SEC = 10 * 60;
export const TRANSFER_RESEND_WINDOW_SEC = 60;
/** Verification attempts (password or code) per owner + workspace per 10 minutes. */
export const TRANSFER_MAX_ATTEMPTS = 5;
export const TRANSFER_ATTEMPT_WINDOW_SEC = 10 * 60;

export const OWNERSHIP_TRANSFER_CODES = {
  /** 400: password method without both fields. */
  passwordRequired: 'TRANSFER_PASSWORD_REQUIRED',
  /** 400: the two password fields differ. */
  passwordMismatch: 'TRANSFER_PASSWORD_MISMATCH',
  /** 403 (not 401: the client must not sign out). */
  passwordInvalid: 'TRANSFER_PASSWORD_INVALID',
  /** 400: code method without `code`. */
  codeRequired: 'TRANSFER_CODE_REQUIRED',
  /** 403: wrong code. */
  codeInvalid: 'TRANSFER_CODE_INVALID',
  /** 403: no code sent, expired, used, or dropped after too many attempts. */
  codeExpired: 'TRANSFER_CODE_EXPIRED',
  /** 429: more than 5 attempts in 10 minutes (a code is dropped too). */
  tooManyAttempts: 'TRANSFER_TOO_MANY_ATTEMPTS',
  /** 429: a code was sent less than a minute ago. */
  resendTooSoon: 'TRANSFER_CODE_RESEND_TOO_SOON',
  /** 409: `…/code` for an owner who has a password. */
  codeNotNeeded: 'TRANSFER_CODE_NOT_NEEDED',
  /** 503: the code email could not be sent (nothing stored, resend allowed at once). */
  emailFailed: 'TRANSFER_CODE_EMAIL_FAILED',
  /** 400: `memberId` is the owner. */
  targetIsSelf: 'TRANSFER_TARGET_IS_SELF',
  /** 404: `memberId` is not a member of this workspace. */
  targetNotFound: 'TRANSFER_TARGET_NOT_FOUND',
  /** 409 (M7-D19): the new owner already owns a billing account in use. */
  targetHasAccount: 'TRANSFER_TARGET_HAS_ACCOUNT',
  /** 409 (M7-D19): the billing account pays for other workspaces too. */
  accountHasOtherWorkspaces: 'TRANSFER_ACCOUNT_HAS_OTHER_WORKSPACES',
  impersonationReadOnly: IMPERSONATION_READ_ONLY,
} as const;
const CODES = OWNERSHIP_TRANSFER_CODES;

export interface TransferInput {
  memberId: string;
  password?: string;
  passwordConfirm?: string;
  code?: string;
}

/** Body rules per method (400 codes), before anything is checked against stored secrets. */
export function transferInputError(
  method: TransferMethod,
  input: Omit<TransferInput, 'memberId'>,
): string | null {
  if (method === 'code') return input.code ? null : CODES.codeRequired;
  if (!input.password || !input.passwordConfirm) return CODES.passwordRequired;
  return input.password === input.passwordConfirm
    ? null
    : CODES.passwordMismatch;
}

/** The new owner's own billing account: none, empty (no workspace/plan/wallet/redemption), or in use. */
export type TargetAccount = 'none' | 'empty' | 'in_use';

export type BillingMove =
  { refusal: string } | { move: boolean; deleteTargetAccount: boolean };

/**
 * M7-D19 (a): the whole account moves only when it pays for this workspace alone; the target's
 * own account is deleted first when empty, else refused. No account (or one the owner doesn't
 * own) → nothing moves.
 */
export function billingMove(input: {
  account: 'none' | 'not_owners' | 'owners';
  hasOtherWorkspaces: boolean;
  targetAccount: TargetAccount;
}): BillingMove {
  if (input.account !== 'owners')
    return { move: false, deleteTargetAccount: false };
  if (input.hasOtherWorkspaces)
    return { refusal: CODES.accountHasOtherWorkspaces };
  if (input.targetAccount === 'in_use')
    return { refusal: CODES.targetHasAccount };
  return { move: true, deleteTargetAccount: input.targetAccount === 'empty' };
}

export const transferKeys = (workspaceId: string, userId: string) => {
  const base = `ownership-transfer:${workspaceId}:${userId}`;
  return {
    code: `${base}:code`,
    attempts: `${base}:attempts`,
    resend: `${base}:resend`,
  };
};

export const newTransferCode = () =>
  randomInt(0, 1_000_000).toString().padStart(6, '0');

/**
 * sha256 of key + code. ponytail: a 6-digit space is brute-forceable from the hash; it only keeps
 * the plain code out of Redis dumps. HMAC with a server secret if that matters.
 */
export const hashTransferCode = (key: string, code: string) =>
  createHash('sha256').update(`${key}:${code}`).digest('hex');

const sameHash = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** The one-time code email (en + bn): the code and the workspace name, no ids, no link. */
export function transferCodeEmail(
  code: string,
  workspaceName: string,
  clientAppUrl: string,
): EmailContent {
  return bilingualEmail(
    {
      en: {
        subject: 'Your code to transfer workspace ownership',
        lines: [
          `Use this code to transfer ownership of "${workspaceName}": ${code}`,
          'It works once and expires in 10 minutes.',
          'If you did not ask for this, ignore this email; nothing changes without the code.',
        ],
      },
      bn: {
        subject: 'ওয়ার্কস্পেসের মালিকানা হস্তান্তরের কোড',
        lines: [
          `"${workspaceName}"-এর মালিকানা হস্তান্তর করতে এই কোডটি দিন: ${code}`,
          'কোডটি একবারই কাজ করবে এবং ১০ মিনিট পর মেয়াদ শেষ হবে।',
          'আপনি এটি না চাইলে ইমেইলটি উপেক্ষা করুন; কোড ছাড়া কিছুই বদলাবে না।',
        ],
      },
    },
    clientAppUrl,
  );
}

const fail = (
  status: HttpStatus,
  code: string,
  message: string,
): HttpException => new HttpException({ message, code }, status);

/**
 * D11 ownership transfer (M7-T6b): verify the owner (password twice, or an emailed one-time code
 * for an owner without a password), then in one transaction the target becomes owner, the old
 * owner admin, and the workspace's billing account (plan, wallet, payments) moves per M7-D19.
 * Every query is scoped by the workspace id; the M7-T6 owner protection on the plugin routes stays.
 */
@Injectable()
export class OwnershipTransferService {
  private readonly logger = new Logger(OwnershipTransferService.name);
  private readonly clientAppUrl: string;

  constructor(
    @InjectDrizzle() private readonly db: Database,
    private readonly store: OwnershipTransferStore,
    private readonly passwords: PasswordService,
    private readonly email: EmailService,
    private readonly team: TeamService,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.clientAppUrl =
      config.get('CLIENT_APP_URL', { infer: true }) ?? DEFAULT_CLIENT_APP_URL;
  }

  async method(userId: string): Promise<TransferMethod> {
    return (await this.passwordHash(userId)) ? 'password' : 'code';
  }

  /** Emails a fresh code (replaces an older one, resets the attempts). */
  async sendCode(
    workspaceId: string,
    owner: { id: string; email: string },
    now: Date = new Date(),
  ): Promise<{ expiresAt: Date; resendAt: Date }> {
    if ((await this.method(owner.id)) !== 'code')
      throw fail(
        HttpStatus.CONFLICT,
        CODES.codeNotNeeded,
        'Confirm with your password instead.',
      );
    const keys = transferKeys(workspaceId, owner.id);
    if ((await this.store.hit(keys.resend, TRANSFER_RESEND_WINDOW_SEC)) > 1)
      throw fail(
        HttpStatus.TOO_MANY_REQUESTS,
        CODES.resendTooSoon,
        'Wait a minute before asking for a new code.',
      );
    const [workspace] = await this.db
      .select({ name: workspaces.name })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    const code = newTransferCode();
    await this.store.put(
      keys.code,
      hashTransferCode(keys.code, code),
      TRANSFER_CODE_TTL_SEC,
    );
    await this.store.del(keys.attempts);
    try {
      const result = await this.email.send({
        to: owner.email,
        ...transferCodeEmail(code, workspace?.name ?? '', this.clientAppUrl),
      });
      // Only outside production (production throws when unconfigured): lets local dev finish.
      if (!result.delivered)
        this.logger.warn(`email not configured; transfer code ${code}`);
    } catch (error) {
      await this.store.del(keys.code, keys.resend);
      this.logger.warn(
        `transfer code email failed workspace=${workspaceId}: ${(error as Error).message}`,
      );
      throw new ServiceUnavailableException({
        message: 'We could not send the code. Try again.',
        code: CODES.emailFailed,
      });
    }
    return {
      expiresAt: new Date(now.getTime() + TRANSFER_CODE_TTL_SEC * 1000),
      resendAt: new Date(now.getTime() + TRANSFER_RESEND_WINDOW_SEC * 1000),
    };
  }

  async transfer(
    workspaceId: string,
    ownerId: string,
    input: TransferInput,
  ): Promise<TeamView> {
    const target = await this.member(workspaceId, input.memberId);
    if (!target)
      throw new NotFoundException({
        message: 'This person is not a member of the workspace.',
        code: CODES.targetNotFound,
      });
    if (target.userId === ownerId)
      throw new BadRequestException({
        message: 'You already own this workspace.',
        code: CODES.targetIsSelf,
      });

    const hash = await this.passwordHash(ownerId);
    const inputError = transferInputError(hash ? 'password' : 'code', input);
    if (inputError)
      throw new BadRequestException({
        message:
          inputError === CODES.passwordMismatch
            ? 'The passwords do not match.'
            : 'Confirm the transfer first.',
        code: inputError,
      });

    const keys = transferKeys(workspaceId, ownerId);
    if (
      (await this.store.hit(keys.attempts, TRANSFER_ATTEMPT_WINDOW_SEC)) >
      TRANSFER_MAX_ATTEMPTS
    ) {
      await this.store.del(keys.code);
      throw fail(
        HttpStatus.TOO_MANY_REQUESTS,
        CODES.tooManyAttempts,
        'Too many attempts. Try again in 10 minutes.',
      );
    }
    if (hash) {
      if (!(await this.passwords.verify(hash, input.password!)))
        throw new ForbiddenException({
          message: 'Your password is not correct.',
          code: CODES.passwordInvalid,
        });
    } else {
      const stored = await this.store.get(keys.code);
      if (!stored)
        throw new ForbiddenException({
          message: 'The code expired. Ask for a new one.',
          code: CODES.codeExpired,
        });
      if (!sameHash(stored, hashTransferCode(keys.code, input.code!)))
        throw new ForbiddenException({
          message: 'The code is not correct.',
          code: CODES.codeInvalid,
        });
    }

    await this.swap(workspaceId, ownerId, target.id);
    await this.store.del(keys.code, keys.attempts);
    this.logger.log(
      `ownership transferred workspace=${workspaceId} from=${ownerId} to=${target.userId}`,
    );
    return this.team.team(workspaceId);
  }

  private async passwordHash(userId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ password: accounts.password })
      .from(accounts)
      .where(
        and(
          eq(accounts.userId, userId),
          eq(accounts.providerId, 'credential'),
          isNotNull(accounts.password),
        ),
      )
      .limit(1);
    return row?.password ?? null;
  }

  private async member(workspaceId: string, memberId: string) {
    const [row] = await this.db
      .select({ id: workspaceMembers.id, userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.id, memberId),
        ),
      );
    return row;
  }

  /** Lock order workspace → members → billing accounts (PW-T5: workspace before account). */
  private async swap(
    workspaceId: string,
    ownerId: string,
    targetMemberId: string,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [workspace] = await tx
        .select({ billingAccountId: workspaces.billingAccountId })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .for('no key update');
      const members = await tx
        .select({
          id: workspaceMembers.id,
          userId: workspaceMembers.userId,
          role: workspaceMembers.role,
        })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspaceId),
            or(
              eq(workspaceMembers.userId, ownerId),
              eq(workspaceMembers.id, targetMemberId),
            ),
          ),
        )
        .for('update');
      const owner = members.find(
        (m) => m.userId === ownerId && m.role === 'owner',
      );
      const target = members.find(
        (m) => m.id === targetMemberId && m.userId !== ownerId,
      );
      // Raced with another transfer or a removal since the checks above.
      if (!owner) throw new ForbiddenException('Insufficient workspace role');
      if (!target)
        throw new NotFoundException({
          message: 'This person is not a member of the workspace.',
          code: CODES.targetNotFound,
        });

      const accountId = workspace?.billingAccountId ?? null;
      const [account] = accountId
        ? await tx
            .select({ ownerUserId: billingAccounts.ownerUserId })
            .from(billingAccounts)
            .where(eq(billingAccounts.id, accountId))
            .for('update')
        : [];
      const [other] = accountId
        ? await tx
            .select({ id: workspaces.id })
            .from(workspaces)
            .where(
              and(
                eq(workspaces.billingAccountId, accountId),
                ne(workspaces.id, workspaceId),
              ),
            )
            .limit(1)
        : [];
      const [targetAccount] = await tx
        .select({ id: billingAccounts.id, inUse: accountInUse })
        .from(billingAccounts)
        .where(eq(billingAccounts.ownerUserId, target.userId))
        .for('update');
      const plan = billingMove({
        account: !account
          ? 'none'
          : account.ownerUserId === ownerId
            ? 'owners'
            : 'not_owners',
        hasOtherWorkspaces: other !== undefined,
        targetAccount: !targetAccount
          ? 'none'
          : targetAccount.inUse
            ? 'in_use'
            : 'empty',
      });
      if ('refusal' in plan)
        throw new ConflictException({
          message:
            plan.refusal === CODES.targetHasAccount
              ? 'This member already has their own plan or workspaces. Ask support to move ownership.'
              : 'Your plan also pays for other workspaces. Move them first or ask support.',
          code: plan.refusal,
        });
      if (plan.deleteTargetAccount)
        await tx
          .delete(billingAccounts)
          .where(eq(billingAccounts.id, targetAccount!.id));
      if (plan.move)
        await tx
          .update(billingAccounts)
          .set({ ownerUserId: target.userId })
          .where(eq(billingAccounts.id, accountId!));

      await tx
        .update(workspaceMembers)
        .set({ role: 'admin' })
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspaceId),
            eq(workspaceMembers.id, owner.id),
          ),
        );
      await tx
        .update(workspaceMembers)
        .set({ role: 'owner' })
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspaceId),
            eq(workspaceMembers.id, target.id),
          ),
        );
    });
  }
}

/** Anything that points at the account (FKs restrict). */
const accountInUse = sql<boolean>`(${sql.join(
  [
    workspaces.billingAccountId,
    subscriptions.billingAccountId,
    wallets.billingAccountId,
    promotionRedemptions.billingAccountId,
    subscriptionAuditLogs.billingAccountId,
    paymentTransactions.billingAccountId,
  ].map(
    (column) =>
      sql`exists (select 1 from ${column.table} where ${column} = ${billingAccounts.id})`,
  ),
  sql` or `,
)})`;
