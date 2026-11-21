import { expect, test } from '@playwright/test';
import { isNonProductionHost, smokeMode, smokeSettings } from './env.js';

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
