import { expect, test } from '@playwright/test';
import { isNonProductionHost, smokeMode, smokeSettings, stagingHosts } from './env.js';

// Pure checks (no browser, no network): the production guard decides what the suite may do.
const urls = (...hosts: string[]) => hosts.map((host) => new URL(`https://${host}`));

test('guard: staging and *.localhost hosts are not production', () => {
  for (const host of ['app.staging.example.com', 'staging.example.com', 'localhost', 'app.localhost']) {
    expect(isNonProductionHost(host), host).toBe(true);
  }
  for (const host of ['example.com', 'app.example.com', 'app-staging.example.com', 'notlocalhost']) {
    expect(isNonProductionHost(host), host).toBe(false);
  }
});

test('guard: staging URLs run everything, production is refused without the override', () => {
  expect(smokeMode(urls('app.staging.example.com', 'api.staging.example.com'), false)).toBe('full');
  expect(smokeMode(urls('app.localhost', 'localhost'), false)).toBe('full');
  expect(() => smokeMode(urls('app.staging.example.com', 'example.com'), false)).toThrow(
    /Refusing to run the smoke suite against production \(example\.com\)/,
  );
  expect(smokeMode(urls('app.example.com', 'api.example.com'), true)).toBe('public');
});

test('guard: the override drops sign-in, missing settings fail clearly', () => {
  const production = {
    SMOKE_CLIENT_URL: 'https://app.example.com',
    SMOKE_ADMIN_URL: 'https://admin.example.com',
    SMOKE_API_URL: 'https://api.example.com/',
    SMOKE_ALLOW_PRODUCTION: '1',
  };
  const settings = smokeSettings(production);
  expect(settings).toMatchObject({ mode: 'public', owner: null, superAdmin: null });
  expect(settings.apiUrl).toBe('https://api.example.com');
  expect(() => smokeSettings({ ...production, SMOKE_ALLOW_PRODUCTION: undefined })).toThrow(/Refusing/);
  expect(() => smokeSettings({ ...production, SMOKE_API_URL: '' })).toThrow(/SMOKE_API_URL is not set/);
  const staging = {
    SMOKE_CLIENT_URL: 'https://app.staging.example.com',
    SMOKE_ADMIN_URL: 'https://admin.staging.example.com',
    SMOKE_API_URL: 'https://api.staging.example.com',
  };
  expect(() => smokeSettings(staging)).toThrow(/SMOKE_OWNER_EMAIL and SMOKE_OWNER_PASSWORD must be set/);
});

test('guard: SMOKE_STAGING_HOSTS allow-lists exact hostnames only (Fly staging, M9-T10b)', () => {
  const allow = stagingHosts(' Shield-Comment-App-Staging.fly.dev , ,shield-comment-admin-staging.fly.dev,, ');
  expect([...allow]).toEqual(['shield-comment-app-staging.fly.dev', 'shield-comment-admin-staging.fly.dev']);
  expect(stagingHosts('  , ,').size).toBe(0);
  expect(stagingHosts(undefined).size).toBe(0);
  expect(
    smokeMode(urls('shield-comment-app-staging.fly.dev', 'SHIELD-COMMENT-ADMIN-STAGING.FLY.DEV'), false, allow),
  ).toBe('full');
  for (const host of [
    'other-app.fly.dev',
    'fly.dev',
    'evil-shield-comment-app-staging.fly.dev',
    'shield-comment-app-staging.fly.dev.evil.com',
  ]) {
    expect(isNonProductionHost(host, allow), host).toBe(false);
    expect(() => smokeMode(urls('shield-comment-app-staging.fly.dev', host), false, allow), host).toThrow(/Refusing/);
  }

  const env = {
    SMOKE_CLIENT_URL: 'https://shield-comment-app-staging.fly.dev',
    SMOKE_ADMIN_URL: 'https://shield-comment-admin-staging.fly.dev',
    SMOKE_API_URL: 'https://shield-comment-api-staging.fly.dev',
    SMOKE_OWNER_EMAIL: 'owner@example.com',
    SMOKE_OWNER_PASSWORD: 'x',
    SMOKE_ADMIN_EMAIL: 'admin@example.com',
    SMOKE_ADMIN_PASSWORD: 'y',
  };
  const listed = `${new URL(env.SMOKE_CLIENT_URL).hostname},${new URL(env.SMOKE_ADMIN_URL).hostname},${new URL(env.SMOKE_API_URL).hostname}`;
  expect(smokeSettings({ ...env, SMOKE_STAGING_HOSTS: listed }).mode).toBe('full');
  // Not listed: refused; a production host stays public-only with the override, allow-list or not.
  expect(() => smokeSettings(env)).toThrow(/Refusing/);
  expect(() => smokeSettings({ ...env, SMOKE_STAGING_HOSTS: ' , ' })).toThrow(/Refusing/);
  const production = {
    ...env,
    SMOKE_CLIENT_URL: 'https://app.example.com',
    SMOKE_STAGING_HOSTS: listed,
    SMOKE_ALLOW_PRODUCTION: '1',
  };
  expect(smokeSettings(production)).toMatchObject({ mode: 'public', owner: null, superAdmin: null });
});
