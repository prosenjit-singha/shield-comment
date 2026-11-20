import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { EnvironmentVariables } from '../config/env.validation.js';
import {
  createSslcommerzConfig,
  PaymentsNotConfiguredError,
  SSLCOMMERZ_LIVE_URL,
  SSLCOMMERZ_SANDBOX_URL,
  SSLCOMMERZ_TIMEOUT_MS,
  sslcommerzCallbackUrls,
  SslcommerzClient,
  type SslcommerzConfig,
  SslcommerzError,
  verifySign,
} from './sslcommerz.client.js';

const PASSWORD = 'unit-store-pass@ssl';
const CONFIG: SslcommerzConfig = {
  storeId: 'unitstore01',
  storePassword: PASSWORD,
  sandbox: true,
  baseUrl: 'http://stub.test',
};
const URLS = sslcommerzCallbackUrls('http://app.localhost:5174/');
const SESSION_INPUT = {
  tranId: 'SC1A2B3C4D5E',
  amountBdt: 1499,
  productName: 'Growth plan (monthly)',
  customer: { name: 'Rahim Uddin', email: 'rahim@example.com' },
  urls: URLS,
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

function configOf(env: Partial<EnvironmentVariables>) {
  return {
    get: (key: keyof EnvironmentVariables) => env[key],
  } as unknown as ConfigService<EnvironmentVariables, true>;
}

const md5 = (value: string) => createHash('md5').update(value).digest('hex');

describe('createSslcommerzConfig (D1)', () => {
  const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockReturnValue(undefined);
  const STORE = {
    SSLCOMMERZ_STORE_ID: 'unitstore01',
    SSLCOMMERZ_STORE_PASSWORD: PASSWORD,
  };
  beforeEach(() => warnSpy.mockClear());

  it('null when unset (production warns once at boot)', () => {
    expect(createSslcommerzConfig(configOf({}))).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(
      createSslcommerzConfig(
        configOf({
          NODE_ENV: 'production' as EnvironmentVariables['NODE_ENV'],
        }),
      ),
    ).toBeNull();
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('not configured');
  });

  it('sandbox by default, live with SSLCOMMERZ_SANDBOX=false, the test override wins', () => {
    expect(createSslcommerzConfig(configOf(STORE))).toEqual({
      storeId: 'unitstore01',
      storePassword: PASSWORD,
      sandbox: true,
      baseUrl: SSLCOMMERZ_SANDBOX_URL,
    });
    const live = createSslcommerzConfig(
      configOf({ ...STORE, SSLCOMMERZ_SANDBOX: 'false' }),
    );
    expect(live?.sandbox).toBe(false);
    expect(live?.baseUrl).toBe(SSLCOMMERZ_LIVE_URL);
    expect(
      createSslcommerzConfig(
        configOf({ ...STORE, SSLCOMMERZ_BASE_URL: 'http://stub:4012/' }),
      )?.baseUrl,
    ).toBe('http://stub:4012');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('production with sandbox on logs a warning; live mode does not', () => {
    const production = 'production' as EnvironmentVariables['NODE_ENV'];
    createSslcommerzConfig(configOf({ ...STORE, NODE_ENV: production }));
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('SANDBOX');
    warnSpy.mockClear();
    createSslcommerzConfig(
      configOf({
        ...STORE,
        NODE_ENV: production,
        SSLCOMMERZ_SANDBOX: 'false',
      }),
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('sslcommerzCallbackUrls', () => {
  it('builds the four URLs under CLIENT_APP_URL/api/billing/sslcommerz', () => {
    expect(URLS).toEqual({
      success: 'http://app.localhost:5174/api/billing/sslcommerz/success',
      fail: 'http://app.localhost:5174/api/billing/sslcommerz/fail',
      cancel: 'http://app.localhost:5174/api/billing/sslcommerz/cancel',
      ipn: 'http://app.localhost:5174/api/billing/sslcommerz/ipn',
    });
  });
});

describe('SslcommerzClient', () => {
  const fetchMock = vi.fn<typeof fetch>();
  const logSpy = vi.spyOn(Logger.prototype, 'log').mockReturnValue(undefined);
  const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockReturnValue(undefined);
  const client = new SslcommerzClient(CONFIG);

  const failure = async (
    run: () => Promise<unknown>,
  ): Promise<SslcommerzError> => {
    const error: unknown = await run().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SslcommerzError);
    expect(String(error)).not.toContain(PASSWORD);
    return error as SslcommerzError;
  };

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(() => {
      throw new Error('Unexpected fetch in this test');
    });
    vi.stubGlobal('fetch', fetchMock);
    logSpy.mockClear();
    warnSpy.mockClear();
  });
  afterEach(() => {
    for (const args of [...logSpy.mock.calls, ...warnSpy.mock.calls])
      expect(args.map(String).join(' ')).not.toContain(PASSWORD);
  });
  afterAll(() => vi.unstubAllGlobals());

  describe('createSession', () => {
    it('POSTs the session form and returns the gateway URL + session key', async () => {
      fetchMock.mockResolvedValueOnce(
        json(200, {
          status: 'SUCCESS',
          sessionkey: 'SK123',
          GatewayPageURL:
            'https://sandbox.sslcommerz.com/EasyCheckOut/testcdeSK123',
        }),
      );
      await expect(client.createSession(SESSION_INPUT)).resolves.toEqual({
        gatewayUrl: 'https://sandbox.sslcommerz.com/EasyCheckOut/testcdeSK123',
        sessionKey: 'SK123',
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe('http://stub.test/gwprocess/v4/api.php');
      expect(init?.method).toBe('POST');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const form = Object.fromEntries(init?.body as URLSearchParams);
      expect(form).toMatchObject({
        store_id: 'unitstore01',
        store_passwd: PASSWORD,
        total_amount: '1499',
        currency: 'BDT',
        tran_id: 'SC1A2B3C4D5E',
        success_url: URLS.success,
        fail_url: URLS.fail,
        cancel_url: URLS.cancel,
        ipn_url: URLS.ipn,
        cus_name: 'Rahim Uddin',
        cus_email: 'rahim@example.com',
        product_name: 'Growth plan (monthly)',
        product_profile: 'non-physical-goods',
        shipping_method: 'NO',
      });
      // D3: every method the store has enabled shows; no filter.
      expect(form).not.toHaveProperty('multi_card_name');
    });

    it('FAILED → SslcommerzError with the gateway reason', async () => {
      fetchMock.mockResolvedValueOnce(
        json(200, { status: 'FAILED', failedreason: 'Store Credential Error' }),
      );
      const error = await failure(() => client.createSession(SESSION_INPUT));
      expect(error.kind).toBe('failed');
      expect(error.reason).toBe('Store Credential Error');
    });

    it('SUCCESS without a gateway URL, a non-JSON body or HTTP 5xx → typed errors', async () => {
      fetchMock.mockResolvedValueOnce(json(200, { status: 'SUCCESS' }));
      expect(
        (await failure(() => client.createSession(SESSION_INPUT))).kind,
      ).toBe('invalid_response');
      fetchMock.mockResolvedValueOnce(new Response('<html>', { status: 200 }));
      expect(
        (await failure(() => client.createSession(SESSION_INPUT))).kind,
      ).toBe('invalid_response');
      fetchMock.mockResolvedValueOnce(json(503, {}));
      const http = await failure(() => client.createSession(SESSION_INPUT));
      expect([http.kind, http.status]).toEqual(['http', 503]);
    });

    it('timeout and network failures', async () => {
      fetchMock.mockRejectedValueOnce(
        new DOMException('The operation timed out.', 'TimeoutError'),
      );
      expect(
        (await failure(() => client.createSession(SESSION_INPUT))).kind,
      ).toBe('timeout');
      fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
      expect(
        (await failure(() => client.createSession(SESSION_INPUT))).kind,
      ).toBe('network');
      expect(SSLCOMMERZ_TIMEOUT_MS).toBeGreaterThan(0);
    });
  });

  describe('validate', () => {
    const validBody = (status: string) => ({
      status,
      tran_id: 'SC1A2B3C4D5E',
      val_id: 'VAL123',
      amount: '1499.00',
      currency: 'BDT',
      currency_type: 'BDT',
      currency_amount: '1499.00',
      bank_tran_id: 'BANK1',
      card_type: 'BKASH-BKash',
      risk_level: '0',
    });

    it('GETs the Order Validation API (JSON) and maps VALID', async () => {
      fetchMock.mockResolvedValueOnce(json(200, validBody('VALID')));
      await expect(client.validate('VAL123')).resolves.toEqual({
        status: 'VALID',
        tranId: 'SC1A2B3C4D5E',
        amount: 1499,
        currency: 'BDT',
        valId: 'VAL123',
        bankTranId: 'BANK1',
        cardType: 'BKASH-BKash',
        riskLevel: 0,
      });
      const url = new URL(fetchMock.mock.calls[0]![0] as string);
      expect(url.origin + url.pathname).toBe(
        'http://stub.test/validator/api/validationserverAPI.php',
      );
      expect(Object.fromEntries(url.searchParams)).toEqual({
        val_id: 'VAL123',
        store_id: 'unitstore01',
        store_passwd: PASSWORD,
        v: '1',
        format: 'json',
      });
      expect(fetchMock.mock.calls[0]![1]?.method).toBe('GET');
    });

    it('VALIDATED (already validated once) and a risky payment', async () => {
      fetchMock.mockResolvedValueOnce(
        json(200, { ...validBody('VALIDATED'), risk_level: '1' }),
      );
      await expect(client.validate('VAL123')).resolves.toMatchObject({
        status: 'VALIDATED',
        riskLevel: 1,
      });
    });

    it('INVALID_TRANSACTION', async () => {
      fetchMock.mockResolvedValueOnce(
        json(200, { status: 'INVALID_TRANSACTION' }),
      );
      await expect(client.validate('VALBAD')).resolves.toEqual({
        status: 'INVALID_TRANSACTION',
        valId: 'VALBAD',
      });
    });

    it('an unknown status or missing fields → invalid_response', async () => {
      fetchMock.mockResolvedValueOnce(json(200, { status: 'PENDING' }));
      expect((await failure(() => client.validate('V'))).kind).toBe(
        'invalid_response',
      );
      fetchMock.mockResolvedValueOnce(
        json(200, { ...validBody('VALID'), tran_id: undefined }),
      );
      expect((await failure(() => client.validate('V'))).kind).toBe(
        'invalid_response',
      );
    });

    it('timeout', async () => {
      fetchMock.mockRejectedValueOnce(
        new DOMException('The operation timed out.', 'TimeoutError'),
      );
      expect((await failure(() => client.validate('V'))).kind).toBe('timeout');
    });
  });

  it('not configured → PaymentsNotConfiguredError, no request', async () => {
    const unconfigured = new SslcommerzClient(null);
    await expect(unconfigured.createSession(SESSION_INPUT)).rejects.toThrow(
      PaymentsNotConfiguredError,
    );
    await expect(unconfigured.validate('V')).rejects.toThrow(
      PaymentsNotConfiguredError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('verifySign', () => {
  /** Signs like SSLCommerz: md5 over the verify_key fields + md5(password), sorted. */
  function signed(fields: Record<string, string>): Record<string, string> {
    const keys = Object.keys(fields);
    const all: Record<string, string> = {
      ...fields,
      store_passwd: md5(PASSWORD),
    };
    const hash = Object.keys(all)
      .sort()
      .map((key) => `${key}=${all[key]}`)
      .join('&');
    return { ...fields, verify_key: keys.join(','), verify_sign: md5(hash) };
  }
  const FIELDS = {
    amount: '1499.00',
    bank_tran_id: 'BANK1',
    currency: 'BDT',
    status: 'VALID',
    tran_id: 'SC1A2B3C4D5E',
    val_id: 'VAL123',
  };

  it('accepts a good signature (extra unsigned fields ignored)', () => {
    expect(verifySign({ ...signed(FIELDS), extra: 'x' }, PASSWORD)).toBe(true);
  });

  it('rejects a tampered field, a wrong password or a bad signature', () => {
    expect(verifySign({ ...signed(FIELDS), amount: '1.00' }, PASSWORD)).toBe(
      false,
    );
    expect(verifySign(signed(FIELDS), 'other-pass')).toBe(false);
    expect(
      verifySign({ ...signed(FIELDS), verify_sign: 'abc' }, PASSWORD),
    ).toBe(false);
  });

  it('rejects a body without verify_key or verify_sign', () => {
    const { verify_key: _k, ...noKey } = signed(FIELDS);
    const { verify_sign: _s, ...noSign } = signed(FIELDS);
    expect(verifySign(noKey, PASSWORD)).toBe(false);
    expect(verifySign(noSign, PASSWORD)).toBe(false);
  });
});
