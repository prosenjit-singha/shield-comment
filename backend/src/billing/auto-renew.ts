import { ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { eq } from 'drizzle-orm';
import { MANUAL_ACTIVATION_ERROR_CODES } from '../admin/manual-activation.js';
import {
  tokenCipherContext,
  TokenCipherService,
} from '../crypto/token-cipher.service.js';
import type { Database } from '../db/database.js';
import { billingAccounts, workspaces } from '../db/schema/index.js';
import {
  SSLCOMMERZ_CONFIG,
  type SslcommerzConfig,
} from '../payments/sslcommerz.client.js';
import type { BillingExecutor } from './subscription.service.js';

/** M8-T6b: summary `autoRenew` + the `PUT/DELETE …/billing/auto-renew` answer. */
export interface AutoRenewView {
  /** `SSLCOMMERZ_TOKENIZATION=true`, SSLCommerz and the token cipher configured. */
  available: boolean;
  /** The owner opted in (always `false` while unavailable). */
  enabled: boolean;
  /** A token from a validated payment is saved (charges need it). */
  tokenSaved: boolean;
}

export const AUTO_RENEW_ERROR_CODES = {
  /** 409: tokenization is off (or SSLCommerz / the cipher unset). */
  unavailable: 'AUTO_RENEW_UNAVAILABLE',
  noBillingAccount: MANUAL_ACTIVATION_ERROR_CODES.noBillingAccount,
} as const;

/** AAD context of `billing_accounts.auto_renew_token`. */
export const autoRenewTokenContext = (accountId: string) =>
  tokenCipherContext('sslcommerz_token', 'billing', accountId);

const UNAVAILABLE: AutoRenewView = {
  available: false,
  enabled: false,
  tokenSaved: false,
};

/**
 * Auto-renew opt-in + saved token per billing account (M8-T6b, D4: off by default, D2: owner only,
 * checked by the controller). Every query is scoped by the account id. The token is only ever
 * stored encrypted and never returned. Used by checkout (ask for a token), the callbacks (save
 * it), the summary and the charge job.
 */
@Injectable()
export class AutoRenewState {
  private readonly logger = new Logger(AutoRenewState.name);

  constructor(
    @InjectDrizzle() private readonly db: Database,
    private readonly cipher: TokenCipherService,
    @Inject(SSLCOMMERZ_CONFIG)
    private readonly config: SslcommerzConfig | null,
  ) {}

  get available(): boolean {
    return this.config?.tokenization === true && this.cipher.isConfigured;
  }

  async view(accountId: string | null): Promise<AutoRenewView> {
    if (!this.available || !accountId) return UNAVAILABLE;
    const [row] = await this.db
      .select({
        enabled: billingAccounts.autoRenewEnabled,
        token: billingAccounts.autoRenewToken,
      })
      .from(billingAccounts)
      .where(eq(billingAccounts.id, accountId));
    return {
      available: true,
      enabled: row?.enabled ?? false,
      tokenSaved: row?.token != null,
    };
  }

  /** Checkout asks SSLCommerz for a token only when available and the owner opted in. */
  async wantsToken(accountId: string): Promise<boolean> {
    return (await this.view(accountId)).enabled;
  }

  async setEnabled(
    workspaceId: string,
    enabled: boolean,
  ): Promise<AutoRenewView> {
    if (!this.available)
      throw new ConflictException({
        message: 'Auto-renew is not available',
        code: AUTO_RENEW_ERROR_CODES.unavailable,
      });
    const accountId = await this.accountOf(workspaceId);
    await this.db
      .update(billingAccounts)
      .set({ autoRenewEnabled: enabled })
      .where(eq(billingAccounts.id, accountId));
    this.logger.log(`auto-renew account=${accountId} enabled=${enabled}`);
    return this.view(accountId);
  }

  /** Removes the saved token and turns auto-renew off (allowed while unavailable too). */
  async removeToken(workspaceId: string): Promise<AutoRenewView> {
    const accountId = await this.accountOf(workspaceId);
    await this.db
      .update(billingAccounts)
      .set({ autoRenewEnabled: false, autoRenewToken: null })
      .where(eq(billingAccounts.id, accountId));
    this.logger.log(`auto-renew token removed account=${accountId}`);
    return this.view(accountId);
  }

  /** A validated payment returned a token: store it encrypted (no-op while unavailable). */
  async saveToken(
    tx: BillingExecutor,
    accountId: string,
    token: string,
  ): Promise<void> {
    if (!this.available) return;
    await tx
      .update(billingAccounts)
      .set({
        autoRenewToken: this.cipher.encrypt(
          token,
          autoRenewTokenContext(accountId),
        ),
      })
      .where(eq(billingAccounts.id, accountId));
    this.logger.log(`auto-renew token saved account=${accountId}`);
  }

  decryptToken(accountId: string, stored: string): string {
    return this.cipher.decrypt(stored, autoRenewTokenContext(accountId));
  }

  private async accountOf(workspaceId: string): Promise<string> {
    const [ws] = await this.db
      .select({ accountId: workspaces.billingAccountId })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    if (!ws?.accountId)
      throw new ConflictException({
        message: 'This workspace has no billing account',
        code: AUTO_RENEW_ERROR_CODES.noBillingAccount,
      });
    return ws.accountId;
  }
}
