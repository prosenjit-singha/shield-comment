import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { validateEnv } from './env.validation.js';

const BASE = {
  DATABASE_URL: 'postgresql://shield:shield@localhost:5432/shield_comment',
  REDIS_URL: 'redis://localhost:6379',
  BETTER_AUTH_SECRET: 'unit-test-better-auth-secret-0123456789',
  BETTER_AUTH_URL: 'http://localhost:3000',
};
const KEY = randomBytes(32).toString('base64');
const OLD_KEY = randomBytes(32).toString('base64');

function expectInvalid(env: Record<string, unknown>, field: string) {
  let message = '';
  try {
    validateEnv({ ...BASE, ...env });
  } catch (error) {
    message = (error as Error).message;
  }
  expect(message).toContain(field);
  // Never echo key material into logs.
  expect(message).not.toContain(KEY);
  expect(message).not.toContain(OLD_KEY);
}

describe('validateEnv: token cipher', () => {
  it('accepts no token env (cipher disabled)', () => {
    const env = validateEnv(BASE);
    expect(env.TOKEN_ENCRYPTION_KEY).toBeUndefined();
  });

  it('accepts a 32-byte key with an id and previous keys', () => {
    const env = validateEnv({
      ...BASE,
      TOKEN_ENCRYPTION_KEY: KEY,
      TOKEN_ENCRYPTION_KEY_ID: 'k2026b',
      TOKEN_ENCRYPTION_PREVIOUS_KEYS: `k2026a:${OLD_KEY}`,
    });
    expect(env.TOKEN_ENCRYPTION_KEY_ID).toBe('k2026b');
  });

  it.each([
    ['31 bytes', randomBytes(31).toString('base64')],
    ['33 bytes', randomBytes(33).toString('base64')],
    ['64-char hex', randomBytes(32).toString('hex')],
    ['empty', ''],
  ])('rejects a key of bad length/encoding: %s', (_name, key) => {
    expectInvalid(
      { TOKEN_ENCRYPTION_KEY: key, TOKEN_ENCRYPTION_KEY_ID: 'k1' },
      'TOKEN_ENCRYPTION_KEY must be base64 of exactly 32 bytes',
    );
  });

  it('rejects a key without an id, and an id without a key', () => {
    expectInvalid({ TOKEN_ENCRYPTION_KEY: KEY }, 'TOKEN_ENCRYPTION_KEY_ID');
    expectInvalid(
      { TOKEN_ENCRYPTION_KEY_ID: 'k1' },
      'TOKEN_ENCRYPTION_KEY must be base64',
    );
  });

  it('rejects a key id with ":" or spaces', () => {
    expectInvalid(
      { TOKEN_ENCRYPTION_KEY: KEY, TOKEN_ENCRYPTION_KEY_ID: 'k:1' },
      'TOKEN_ENCRYPTION_KEY_ID must match',
    );
  });

  it('rejects previous keys without a current key', () => {
    expectInvalid(
      { TOKEN_ENCRYPTION_PREVIOUS_KEYS: `k0:${OLD_KEY}` },
      'TOKEN_ENCRYPTION_KEY must be base64',
    );
  });

  it.each([
    [
      'bad previous key length',
      `k0:${randomBytes(16).toString('base64')}`,
      'must be base64 of exactly 32 bytes',
    ],
    ['reused current id', `k1:${OLD_KEY}`, 'must not reuse the current key id'],
    ['duplicate previous ids', `k0:${OLD_KEY},k0:${OLD_KEY}`, 'listed twice'],
  ])('rejects %s', (_name, previous, message) => {
    expectInvalid(
      {
        TOKEN_ENCRYPTION_KEY: KEY,
        TOKEN_ENCRYPTION_KEY_ID: 'k1',
        TOKEN_ENCRYPTION_PREVIOUS_KEYS: previous,
      },
      message,
    );
  });
});

describe('validateEnv: Meta app', () => {
  const SECRET = 'meta-app-secret-0123456789abcdef';
  const META = {
    META_APP_ID: '1234567890',
    META_APP_SECRET: SECRET,
    META_LOGIN_CONFIG_ID: '987654321',
    META_OAUTH_REDIRECT_URI:
      'http://app.localhost:5174/api/meta/oauth/callback',
  };

  function metaError(env: Record<string, unknown>): string {
    try {
      validateEnv({ ...BASE, ...env });
    } catch (error) {
      return (error as Error).message;
    }
    return '';
  }

  it('accepts no Meta env (client disabled) and the full set', () => {
    expect(validateEnv(BASE).META_APP_ID).toBeUndefined();
    const env = validateEnv({
      ...BASE,
      ...META,
      META_GRAPH_API_VERSION: 'v27.0',
    });
    expect(env.META_APP_ID).toBe('1234567890');
    expect(env.META_GRAPH_API_VERSION).toBe('v27.0');
  });

  it('requires all four app vars together', () => {
    const message = metaError({ META_APP_ID: '1234567890' });
    expect(message).toContain('META_APP_SECRET');
    expect(message).toContain('META_LOGIN_CONFIG_ID');
    expect(message).toContain('META_OAUTH_REDIRECT_URI');
    expect(message).not.toContain('- META_APP_ID');
  });

  it.each([
    ['META_APP_ID', 'abc'],
    ['META_LOGIN_CONFIG_ID', '12a'],
    ['META_APP_SECRET', 'short'],
    ['META_OAUTH_REDIRECT_URI', '/api/meta/oauth/callback'],
    ['META_GRAPH_API_VERSION', '26.0'],
    ['META_GRAPH_API_VERSION', 'v26'],
  ])('rejects a bad %s', (field, value) => {
    const message = metaError({ ...META, [field]: value });
    expect(message).toContain(`- ${field}:`);
    // Messages never echo values (the secret above all).
    expect(message).not.toContain(SECRET);
    expect(message).not.toContain(`${value} `);
  });
});

describe('validateEnv: META_GRAPH_BASE_URL (M6-T4, D17)', () => {
  const error = (env: Record<string, unknown>) => {
    try {
      validateEnv({ ...BASE, ...env });
    } catch (e) {
      return (e as Error).message;
    }
    return '';
  };

  it('is optional and accepts an http(s) URL outside production', () => {
    expect(validateEnv(BASE).META_GRAPH_BASE_URL).toBeUndefined();
    expect(
      validateEnv({ ...BASE, META_GRAPH_BASE_URL: 'http://graph-stub:4010' })
        .META_GRAPH_BASE_URL,
    ).toBe('http://graph-stub:4010');
  });

  it.each(['graph-stub:4010', 'ftp://graph-stub', '/v26.0'])(
    'rejects %s',
    (value) => {
      expect(error({ META_GRAPH_BASE_URL: value })).toContain(
        '- META_GRAPH_BASE_URL:',
      );
    },
  );

  it('is refused when NODE_ENV=production', () => {
    expect(
      error({
        NODE_ENV: 'production',
        META_GRAPH_BASE_URL: 'http://graph-stub:4010',
      }),
    ).toContain('must not be set when NODE_ENV=production');
    expect(
      validateEnv({
        ...BASE,
        NODE_ENV: 'production',
        TRUSTED_ORIGINS: 'https://app.shield.test',
      }).NODE_ENV,
    ).toBe('production');
  });
});

describe('validateEnv: Meta webhook verify token', () => {
  const TOKEN = 'verify-token-0123456789abcdef';

  function tokenError(value: string): string {
    try {
      validateEnv({ ...BASE, META_WEBHOOK_VERIFY_TOKEN: value });
    } catch (error) {
      return (error as Error).message;
    }
    return '';
  }

  it('is optional and independent of the Meta app vars', () => {
    expect(validateEnv(BASE).META_WEBHOOK_VERIFY_TOKEN).toBeUndefined();
    expect(
      validateEnv({ ...BASE, META_WEBHOOK_VERIFY_TOKEN: TOKEN })
        .META_WEBHOOK_VERIFY_TOKEN,
    ).toBe(TOKEN);
  });

  it.each([
    ['too short', 'short-token'],
    ['with a space', 'verify token 0123456789'],
    ['non-ASCII', 'verify-token-০১২৩৪৫৬৭৮৯'],
    ['empty', ''],
    ['too long', 'x'.repeat(257)],
  ])('rejects a token %s without echoing it', (_label, value) => {
    const message = tokenError(value);
    expect(message).toContain('- META_WEBHOOK_VERIFY_TOKEN:');
    if (value) expect(message).not.toContain(value);
  });
});

describe('validateEnv: AI provider', () => {
  it('is optional and accepts each provider with its key', () => {
    expect(validateEnv(BASE).AI_PROVIDER).toBeUndefined();
    const env = validateEnv({
      ...BASE,
      AI_PROVIDER: 'google',
      GEMINI_API_KEY: 'AIza-test-key',
      OPENAI_API_KEY: 'sk-test',
      ANTHROPIC_API_KEY: 'sk-ant-test',
      AI_GATEWAY_MODEL: 'gemini-2.5-flash',
    });
    expect(env).toMatchObject({
      AI_PROVIDER: 'google',
      GEMINI_API_KEY: 'AIza-test-key',
    });
    for (const provider of ['neon', 'openai', 'anthropic']) {
      expect(validateEnv({ ...BASE, AI_PROVIDER: provider }).AI_PROVIDER).toBe(
        provider,
      );
    }
  });

  it.each(['gemini', 'NEON', 'azure', ''])(
    'rejects AI_PROVIDER=%j',
    (value) => {
      expect(() => validateEnv({ ...BASE, AI_PROVIDER: value })).toThrow(
        '- AI_PROVIDER:',
      );
    },
  );
});

describe('validateEnv: AI cost estimate (M5-T13)', () => {
  it('defaults the BDT rate to 122 and has no price override', () => {
    const env = validateEnv(BASE);
    expect(env.AI_COST_USD_TO_BDT).toBe(122);
    expect(env.AI_MODEL_PRICES).toBeUndefined();
  });

  it('accepts a decimal rate and a price list', () => {
    const env = validateEnv({
      ...BASE,
      AI_COST_USD_TO_BDT: '121.75',
      AI_MODEL_PRICES: 'neon:gpt-oss-20b=0.05/0.2, openai:gpt-4.1-mini=0.4/1.6',
    });
    expect(env.AI_COST_USD_TO_BDT).toBe(121.75);
    expect(env.AI_MODEL_PRICES).toContain('neon:gpt-oss-20b');
  });

  it.each(['0', '-5', 'abc', '1001', '1.123456'])(
    'rejects AI_COST_USD_TO_BDT=%j',
    (value) => {
      expectInvalid({ AI_COST_USD_TO_BDT: value }, '- AI_COST_USD_TO_BDT:');
    },
  );

  it.each([
    ['azure:gpt=1/2', 'provider must be one of'],
    ['neon:gpt-oss-20b=1', 'price must be'],
    ['neon=1/2', 'must look like'],
    ['neon:m=1/2,neon:m=3/4', 'duplicate'],
  ])('rejects AI_MODEL_PRICES=%j', (value, reason) => {
    expectInvalid({ AI_MODEL_PRICES: value }, `AI_MODEL_PRICES: entry`);
    expectInvalid({ AI_MODEL_PRICES: value }, reason);
  });
});

describe('validateEnv: transactional email (M7-T1)', () => {
  const RESEND_KEY = 're_test_0123456789abcdef';

  it('accepts no email env (dev log fallback)', () => {
    const env = validateEnv(BASE);
    expect(env.RESEND_API_KEY).toBeUndefined();
    expect(env.EMAIL_FROM).toBeUndefined();
  });

  it.each(['alerts@example.com', 'ShieldComment BD <alerts@example.com>'])(
    'accepts EMAIL_FROM=%j with a key',
    (from) => {
      const env = validateEnv({
        ...BASE,
        RESEND_API_KEY: RESEND_KEY,
        EMAIL_FROM: from,
      });
      expect(env.EMAIL_FROM).toBe(from);
    },
  );

  it.each([
    'not-an-email',
    'Name <bad>',
    '<alerts@example.com>',
    'a@example.com\nBcc: b@example.com',
    '',
  ])('rejects a bad from address %j at boot', (from) => {
    expectInvalid(
      { RESEND_API_KEY: RESEND_KEY, EMAIL_FROM: from },
      '- EMAIL_FROM:',
    );
  });

  it('needs both: a key without a from address, or the reverse, fails', () => {
    expectInvalid({ RESEND_API_KEY: RESEND_KEY }, '- EMAIL_FROM:');
    expectInvalid({ EMAIL_FROM: 'alerts@example.com' }, '- RESEND_API_KEY:');
  });

  it('rejects a key that is not a Resend key, without echoing it', () => {
    let message = '';
    try {
      validateEnv({
        ...BASE,
        RESEND_API_KEY: 'sk-secret-value-123456',
        EMAIL_FROM: 'alerts@example.com',
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('- RESEND_API_KEY:');
    expect(message).not.toContain('sk-secret-value-123456');
  });
});

describe('validateEnv: Telegram bot (M7-T8, D13)', () => {
  const TELEGRAM = {
    TELEGRAM_BOT_TOKEN: '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw',
    TELEGRAM_BOT_USERNAME: 'ShieldCommentBot',
    TELEGRAM_WEBHOOK_SECRET: 'telegram-webhook-secret-0123',
  };

  it('accepts none (Telegram off) or all three', () => {
    expect(validateEnv(BASE).TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(validateEnv({ ...BASE, ...TELEGRAM }).TELEGRAM_BOT_USERNAME).toBe(
      'ShieldCommentBot',
    );
  });

  it.each(Object.keys(TELEGRAM))('needs all three: %s missing fails', (key) => {
    const env: Record<string, string> = { ...TELEGRAM };
    delete env[key];
    expectInvalid(env, `- ${key}:`);
  });

  it.each([
    ['TELEGRAM_BOT_TOKEN', 'not-a-token'],
    ['TELEGRAM_BOT_USERNAME', '@ShieldCommentBot'],
    ['TELEGRAM_BOT_USERNAME', 'ShieldComment'],
    ['TELEGRAM_WEBHOOK_SECRET', 'short'],
    ['TELEGRAM_WEBHOOK_SECRET', 'has spaces in the secret value'],
  ])('rejects bad %s=%j without echoing it', (key, value) => {
    let message = '';
    try {
      validateEnv({ ...BASE, ...TELEGRAM, [key]: value });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(`- ${key}:`);
    expect(message).not.toContain(value);
  });

  it('TELEGRAM_API_BASE_URL: test-only absolute URL, refused in production', () => {
    expect(
      validateEnv({ ...BASE, TELEGRAM_API_BASE_URL: 'http://127.0.0.1:4011' })
        .TELEGRAM_API_BASE_URL,
    ).toBe('http://127.0.0.1:4011');
    expectInvalid(
      { TELEGRAM_API_BASE_URL: 'not a url' },
      '- TELEGRAM_API_BASE_URL:',
    );
    expectInvalid(
      { NODE_ENV: 'production', TELEGRAM_API_BASE_URL: 'http://stub:4011' },
      'must not be set when NODE_ENV=production',
    );
  });
});

describe('validateEnv: SSLCommerz (M8-T1, D1)', () => {
  const STORE = {
    SSLCOMMERZ_STORE_ID: 'shiel6abc0123',
    SSLCOMMERZ_STORE_PASSWORD: 'shiel6abc0123@ssl',
  };

  it('all optional; sandbox defaults to true; store id + password together', () => {
    const env = validateEnv(BASE);
    expect(env.SSLCOMMERZ_STORE_ID).toBeUndefined();
    expect(env.SSLCOMMERZ_SANDBOX).toBe('true');
    expect(
      validateEnv({ ...BASE, ...STORE, SSLCOMMERZ_SANDBOX: 'false' })
        .SSLCOMMERZ_SANDBOX,
    ).toBe('false');
    expectInvalid(
      { SSLCOMMERZ_STORE_ID: STORE.SSLCOMMERZ_STORE_ID },
      '- SSLCOMMERZ_STORE_PASSWORD:',
    );
    expectInvalid(
      { SSLCOMMERZ_STORE_PASSWORD: STORE.SSLCOMMERZ_STORE_PASSWORD },
      '- SSLCOMMERZ_STORE_ID:',
    );
    expectInvalid({ SSLCOMMERZ_SANDBOX: 'yes' }, '- SSLCOMMERZ_SANDBOX:');
  });

  it('never echoes the store password', () => {
    let message = '';
    try {
      validateEnv({
        ...BASE,
        SSLCOMMERZ_STORE_ID: 'bad id',
        SSLCOMMERZ_STORE_PASSWORD: 'secret pass',
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('- SSLCOMMERZ_STORE_PASSWORD:');
    expect(message).not.toContain('secret pass');
  });

  it('SSLCOMMERZ_BASE_URL: test-only absolute URL, refused in production', () => {
    expect(
      validateEnv({ ...BASE, SSLCOMMERZ_BASE_URL: 'http://127.0.0.1:4012' })
        .SSLCOMMERZ_BASE_URL,
    ).toBe('http://127.0.0.1:4012');
    expectInvalid(
      { SSLCOMMERZ_BASE_URL: 'not a url' },
      '- SSLCOMMERZ_BASE_URL:',
    );
    expectInvalid(
      { NODE_ENV: 'production', SSLCOMMERZ_BASE_URL: 'http://stub:4012' },
      'SSLCOMMERZ_BASE_URL is a test-only override and must not be set when NODE_ENV=production',
    );
  });
});

describe('validateEnv: production origins (M9-T3, D3)', () => {
  const PROD = {
    ...BASE,
    NODE_ENV: 'production',
    BETTER_AUTH_URL: 'https://api.shield.test',
    TRUSTED_ORIGINS: 'https://app.shield.test, https://admin.shield.test',
    CLIENT_APP_URL: 'https://app.shield.test',
  };
  const error = (env: Record<string, unknown>) => {
    try {
      validateEnv(env);
    } catch (e) {
      return (e as Error).message;
    }
    return '';
  };
  const HTTPS_RULE = 'must use https:// when NODE_ENV=production';

  it('accepts https origins + URLs, CORS unset', () => {
    const env = validateEnv(PROD);
    expect(env.TRUSTED_ORIGINS).toBe(PROD.TRUSTED_ORIGINS);
    expect(env.CORS_ORIGINS).toBeUndefined();
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['only commas/spaces', ' , '],
  ])('refuses a %s TRUSTED_ORIGINS', (_name, value) => {
    expect(error({ ...PROD, TRUSTED_ORIGINS: value })).toContain(
      '- TRUSTED_ORIGINS: is required when NODE_ENV=production',
    );
  });

  it.each([
    ['TRUSTED_ORIGINS', 'https://app.shield.test,http://admin.shield.test', 2],
    ['TRUSTED_ORIGINS', 'app.shield.test', 1],
    ['CORS_ORIGINS', 'http://app.shield.test', 1],
    ['CORS_ORIGINS', 'https://app.shield.test, http://evil.test', 2],
  ])('refuses %s entry that is not https: %s', (name, value, entry) => {
    const message = error({ ...PROD, [name]: value });
    expect(message).toContain(`- ${name}: entry ${entry} ${HTTPS_RULE}`);
    // Names the variable, never echoes the value.
    expect(message).not.toContain('shield.test');
  });

  it.each(['BETTER_AUTH_URL', 'CLIENT_APP_URL'])(
    'refuses an http %s',
    (name) => {
      expect(error({ ...PROD, [name]: 'http://api.shield.test' })).toContain(
        `- ${name}: ${HTTPS_RULE}`,
      );
    },
  );

  it('lists every refusal at once', () => {
    const message = error({
      ...PROD,
      TRUSTED_ORIGINS: undefined,
      CORS_ORIGINS: 'http://a.test',
      BETTER_AUTH_URL: 'http://api.test',
      CLIENT_APP_URL: 'http://app.test',
    });
    for (const name of [
      'TRUSTED_ORIGINS',
      'CORS_ORIGINS',
      'BETTER_AUTH_URL',
      'CLIENT_APP_URL',
    ]) {
      expect(message).toContain(`- ${name}:`);
    }
  });

  it('allows http on localhost and *.localhost (compose)', () => {
    expect(() =>
      validateEnv({
        ...PROD,
        BETTER_AUTH_URL: 'http://localhost:3000',
        CLIENT_APP_URL: 'http://app.localhost:5174',
        TRUSTED_ORIGINS: 'http://admin.localhost:5173,http://localhost:5174',
        CORS_ORIGINS: 'http://app.localhost:5174',
      }),
    ).not.toThrow();
  });

  it('refuses look-alike hosts (localhost.evil.test, xlocalhost)', () => {
    expect(
      error({ ...PROD, TRUSTED_ORIGINS: 'http://localhost.evil.test' }),
    ).toContain(`- TRUSTED_ORIGINS: entry 1 ${HTTPS_RULE}`);
    expect(error({ ...PROD, CLIENT_APP_URL: 'http://xlocalhost' })).toContain(
      `- CLIENT_APP_URL: ${HTTPS_RULE}`,
    );
  });

  it('passes the docker-compose backend env (NODE_ENV=production on http://*.localhost)', () => {
    const origins =
      'http://admin.localhost:5173,http://app.localhost:5174,http://localhost:5173,http://localhost:5174';
    expect(() =>
      validateEnv({
        ...BASE,
        NODE_ENV: 'production',
        TRUST_PROXY_HOPS: '1',
        CORS_ORIGINS: origins,
        BETTER_AUTH_URL: 'http://localhost:3000',
        TRUSTED_ORIGINS: origins,
        CLIENT_APP_URL: 'http://app.localhost:5174',
      }),
    ).not.toThrow();
  });

  it.each(['development', 'test'])(
    'does not check origins when NODE_ENV=%s',
    (nodeEnv) => {
      expect(() =>
        validateEnv({
          ...BASE,
          NODE_ENV: nodeEnv,
          BETTER_AUTH_URL: 'http://api.shield.test',
          CORS_ORIGINS: 'http://evil.test',
          CLIENT_APP_URL: 'http://app.shield.test',
        }),
      ).not.toThrow();
    },
  );
});
