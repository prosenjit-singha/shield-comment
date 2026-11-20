import { createHash, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  NodeEnv,
  type EnvironmentVariables,
} from '../config/env.validation.js';

/** SSLCommerz V4 hosts (Module 8 D1): `SSLCOMMERZ_SANDBOX` picks one, `SSLCOMMERZ_BASE_URL` (tests) wins. */
export const SSLCOMMERZ_SANDBOX_URL = 'https://sandbox.sslcommerz.com';
export const SSLCOMMERZ_LIVE_URL = 'https://securepay.sslcommerz.com';
export const SSLCOMMERZ_SESSION_PATH = '/gwprocess/v4/api.php';
export const SSLCOMMERZ_VALIDATION_PATH =
  '/validator/api/validationserverAPI.php';
export const SSLCOMMERZ_TIMEOUT_MS = 20_000;
/** Gateway reasons are short; cap them so an odd body can't flood errors. */
const REASON_MAX = 200;

export interface SslcommerzConfig {
  storeId: string;
  storePassword: string;
  sandbox: boolean;
  /** No trailing slash. */
  baseUrl: string;
}

/** DI token for `SslcommerzConfig | null` (`null` = store id/password unset). */
export const SSLCOMMERZ_CONFIG = Symbol('SSLCOMMERZ_CONFIG');

/** Env validation already checked the values (id + password both or neither). */
export function createSslcommerzConfig(
  config: ConfigService<EnvironmentVariables, true>,
): SslcommerzConfig | null {
  const logger = new Logger('SslcommerzClient');
  const production =
    config.get('NODE_ENV', { infer: true }) === NodeEnv.Production;
  const storeId = config.get('SSLCOMMERZ_STORE_ID', { infer: true });
  const storePassword = config.get('SSLCOMMERZ_STORE_PASSWORD', {
    infer: true,
  });
  if (!storeId || !storePassword) {
    if (production)
      logger.warn(
        'SSLCommerz is not configured (SSLCOMMERZ_STORE_ID, SSLCOMMERZ_STORE_PASSWORD): checkout answers 503',
      );
    return null;
  }
  const sandbox = config.get('SSLCOMMERZ_SANDBOX', { infer: true }) !== 'false';
  if (production && sandbox)
    logger.warn(
      'SSLCommerz runs in SANDBOX mode in production: payments are not real (set SSLCOMMERZ_SANDBOX=false)',
    );
  const override = config.get('SSLCOMMERZ_BASE_URL', { infer: true });
  return {
    storeId,
    storePassword,
    sandbox,
    baseUrl: (
      override ?? (sandbox ? SSLCOMMERZ_SANDBOX_URL : SSLCOMMERZ_LIVE_URL)
    ).replace(/\/+$/, ''),
  };
}

export interface SslcommerzCallbackUrls {
  success: string;
  fail: string;
  cancel: string;
  ipn: string;
}

/** Callbacks go through the client's same-origin `/api` proxy (M8 reading 4). */
export function sslcommerzCallbackUrls(
  clientAppUrl: string,
): SslcommerzCallbackUrls {
  const base = `${clientAppUrl.replace(/\/+$/, '')}/api/billing/sslcommerz`;
  return {
    success: `${base}/success`,
    fail: `${base}/fail`,
    cancel: `${base}/cancel`,
    ipn: `${base}/ipn`,
  };
}

export interface CreateSessionInput {
  /** Our unique id (≤ 30 chars), echoed back by IPN / validation. */
  tranId: string;
  /** Whole ৳, ≥ 10 (SSLCommerz minimum; the checkout checks it). */
  amountBdt: number;
  productName: string;
  customer: { name: string; email: string; phone?: string };
  urls: SslcommerzCallbackUrls;
}

export interface SslcommerzSession {
  gatewayUrl: string;
  sessionKey: string;
}

export type SslcommerzValidation =
  | {
      status: 'VALID' | 'VALIDATED';
      tranId: string;
      /** Charged amount in `currency`. */
      amount: number;
      /** The currency sent at session creation (`currency_type`), `BDT` for us. */
      currency: string;
      valId: string;
      bankTranId: string | null;
      /** e.g. `BKASH-BKash`, `NAGAD-Nagad`, `VISA-Dutch Bangla`. */
      cardType: string | null;
      /** 0 = safe, 1 = risky (Module 8 D10). */
      riskLevel: number;
    }
  | { status: 'INVALID_TRANSACTION'; valId: string };

/** `SSLCOMMERZ_STORE_ID` / `SSLCOMMERZ_STORE_PASSWORD` unset; later rows answer 503 `PAYMENTS_NOT_CONFIGURED`. */
export class PaymentsNotConfiguredError extends Error {
  constructor() {
    super(
      'Payments are not configured (SSLCOMMERZ_STORE_ID, SSLCOMMERZ_STORE_PASSWORD)',
    );
    this.name = 'PaymentsNotConfiguredError';
  }
}

export type SslcommerzErrorKind =
  'timeout' | 'network' | 'http' | 'failed' | 'invalid_response';

/** Never contains the store password. `reason` = the gateway's `failedreason` (kind `failed`). */
export class SslcommerzError extends Error {
  constructor(
    readonly kind: SslcommerzErrorKind,
    /** HTTP status; `null` for network failures and timeouts. */
    readonly status: number | null,
    readonly reason?: string,
  ) {
    super(
      `SSLCommerz request failed: ${kind}${status ? ` (${status})` : ''}${reason ? `: ${reason}` : ''}`,
    );
    this.name = 'SslcommerzError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

const md5 = (value: string) => createHash('md5').update(value).digest('hex');

/**
 * IPN / return-URL signature check (pure): md5 of `key=value&…` over the fields named in
 * `verify_key` plus `store_passwd` = md5(store password), sorted by key. Missing `verify_key` /
 * `verify_sign` → false.
 */
export function verifySign(
  body: Record<string, unknown>,
  storePassword: string,
): boolean {
  const verifyKey = str(body.verify_key);
  const verifySign = str(body.verify_sign);
  if (!verifyKey || !verifySign) return false;
  const fields = new Map<string, string>();
  for (const key of verifyKey.split(',')) {
    const value = body[key];
    if (typeof value === 'string') fields.set(key, value);
  }
  fields.set('store_passwd', md5(storePassword));
  const hashString = [...fields.keys()]
    .sort()
    .map((key) => `${key}=${fields.get(key)}`)
    .join('&');
  const expected = Buffer.from(md5(hashString));
  const actual = Buffer.from(verifySign.toLowerCase());
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** The only code that calls SSLCommerz (always mocked in tests). Logs ids/status only. */
@Injectable()
export class SslcommerzClient {
  private readonly logger = new Logger(SslcommerzClient.name);

  constructor(
    @Inject(SSLCOMMERZ_CONFIG) private readonly config: SslcommerzConfig | null,
  ) {}

  /** Session API (form POST) → hosted checkout URL. D3: no `multi_card_name`, the store's methods all show. */
  async createSession(input: CreateSessionInput): Promise<SslcommerzSession> {
    const config = this.requireConfig();
    const form = new URLSearchParams({
      store_id: config.storeId,
      store_passwd: config.storePassword,
      total_amount: String(input.amountBdt),
      currency: 'BDT',
      tran_id: input.tranId,
      success_url: input.urls.success,
      fail_url: input.urls.fail,
      cancel_url: input.urls.cancel,
      ipn_url: input.urls.ipn,
      cus_name: input.customer.name,
      cus_email: input.customer.email,
      // Required by SSLCommerz; we don't collect a postal address or phone for a digital plan.
      cus_add1: 'Dhaka',
      cus_city: 'Dhaka',
      cus_postcode: '1000',
      cus_country: 'Bangladesh',
      cus_phone: input.customer.phone ?? 'N/A',
      shipping_method: 'NO',
      num_of_item: '1',
      product_name: input.productName,
      product_category: 'Software',
      product_profile: 'non-physical-goods',
    });
    const body = await this.request(
      `${config.baseUrl}${SSLCOMMERZ_SESSION_PATH}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form,
      },
      `session tran_id=${input.tranId}`,
    );
    const status = str(body.status);
    const gatewayUrl = str(body.GatewayPageURL);
    const sessionKey = str(body.sessionkey);
    if (status === 'SUCCESS' && gatewayUrl && sessionKey) {
      this.logger.log(
        `sslcommerz session created tran_id=${input.tranId} session=${sessionKey}`,
      );
      return { gatewayUrl, sessionKey };
    }
    if (status === 'FAILED') {
      this.logger.warn(
        `sslcommerz session failed tran_id=${input.tranId} status=FAILED`,
      );
      throw new SslcommerzError(
        'failed',
        null,
        (str(body.failedreason) ?? 'unknown').slice(0, REASON_MAX),
      );
    }
    throw this.failed(
      new SslcommerzError('invalid_response', null),
      `session tran_id=${input.tranId}`,
    );
  }

  /** Order Validation API (JSON) for a `val_id` from the IPN / success return. */
  async validate(valId: string): Promise<SslcommerzValidation> {
    const config = this.requireConfig();
    const query = new URLSearchParams({
      val_id: valId,
      store_id: config.storeId,
      store_passwd: config.storePassword,
      v: '1',
      format: 'json',
    });
    const context = `validation val_id=${valId}`;
    const body = await this.request(
      `${config.baseUrl}${SSLCOMMERZ_VALIDATION_PATH}?${query.toString()}`,
      { method: 'GET' },
      context,
    );
    const status = str(body.status);
    if (status === 'INVALID_TRANSACTION') {
      this.logger.warn(`sslcommerz ${context} status=INVALID_TRANSACTION`);
      return { status, valId };
    }
    const tranId = str(body.tran_id);
    const amount = Number(str(body.currency_amount) ?? str(body.amount));
    const currency = str(body.currency_type) ?? str(body.currency);
    if (
      (status !== 'VALID' && status !== 'VALIDATED') ||
      !tranId ||
      !Number.isFinite(amount) ||
      !currency
    ) {
      throw this.failed(new SslcommerzError('invalid_response', null), context);
    }
    const riskLevel = Number(str(body.risk_level) ?? 0);
    this.logger.log(
      `sslcommerz ${context} status=${status} tran_id=${tranId} risk=${riskLevel}`,
    );
    return {
      status,
      tranId,
      amount,
      currency,
      valId: str(body.val_id) ?? valId,
      bankTranId: str(body.bank_tran_id),
      cardType: str(body.card_type),
      riskLevel: Number.isFinite(riskLevel) ? riskLevel : 0,
    };
  }

  private requireConfig(): SslcommerzConfig {
    if (!this.config) throw new PaymentsNotConfiguredError();
    return this.config;
  }

  /** fetch + JSON object body; the URL (it may hold the password) is never logged. */
  private async request(
    url: string,
    init: RequestInit,
    context: string,
  ): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(SSLCOMMERZ_TIMEOUT_MS),
      });
    } catch (error) {
      throw this.failed(
        new SslcommerzError(
          error instanceof Error && error.name === 'TimeoutError'
            ? 'timeout'
            : 'network',
          null,
        ),
        context,
      );
    }
    if (!res.ok)
      throw this.failed(new SslcommerzError('http', res.status), context);
    const body: unknown = await res.json().catch(() => undefined);
    if (!isRecord(body))
      throw this.failed(
        new SslcommerzError('invalid_response', res.status),
        context,
      );
    return body;
  }

  private failed(error: SslcommerzError, context: string): SslcommerzError {
    this.logger.warn(
      `sslcommerz ${context} failed: kind=${error.kind} status=${error.status ?? 'none'}`,
    );
    return error;
  }
}
