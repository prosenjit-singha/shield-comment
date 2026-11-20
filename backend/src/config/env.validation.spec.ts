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
    expect(validateEnv({ ...BASE, NODE_ENV: 'production' }).NODE_ENV).toBe(
      'production',
    );
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
