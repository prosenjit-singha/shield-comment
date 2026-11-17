import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { EnvironmentVariables } from '../config/env.validation.js';
import { TokenService } from './token.service.js';

const env = {
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  JWT_REFRESH_SECRET: 'r'.repeat(32),
  JWT_ACCESS_TTL_SECONDS: 900,
  JWT_REFRESH_TTL_SECONDS: 604_800,
};
// Minimal ConfigService stand-in: only `get` is used.
const config = {
  get: (key: keyof typeof env) => env[key],
} as unknown as ConfigService<EnvironmentVariables, true>;

describe('TokenService', () => {
  const jwt = new JwtService();
  const tokens = new TokenService(jwt, config);

  afterEach(() => {
    vi.useRealTimers();
  });

  it('signs an access token that verifies back to the same claims', async () => {
    const token = await tokens.signAccess({ sub: 'user-1', role: 'USER' });
    const payload = await tokens.verifyAccess(token);
    expect(payload).toMatchObject({ sub: 'user-1', role: 'USER', typ: 'access' });
    expect(payload).not.toHaveProperty('impersonatedBy');
  });

  it('uses HS256 and the configured TTL', async () => {
    const token = await tokens.signAccess({ sub: 'user-1', role: 'USER' });
    const [rawHeader = '', rawPayload = ''] = token.split('.');
    const header = JSON.parse(Buffer.from(rawHeader, 'base64url').toString()) as { alg: string };
    const payload = JSON.parse(Buffer.from(rawPayload, 'base64url').toString()) as {
      exp: number;
      iat: number;
    };
    expect(header.alg).toBe('HS256');
    expect(payload.exp - payload.iat).toBe(900);
  });

  it('issues a pair whose refresh token verifies as a refresh token', async () => {
    const pair = await tokens.issuePair({ sub: 'user-2', role: 'SUPER_ADMIN' });
    expect(pair.expiresIn).toBe(900);
    await expect(tokens.verifyRefresh(pair.refreshToken)).resolves.toMatchObject({
      sub: 'user-2',
      typ: 'refresh',
    });
  });

  it('rejects a refresh token used as an access token, and vice versa', async () => {
    const pair = await tokens.issuePair({ sub: 'user-3', role: 'USER' });
    await expect(tokens.verifyAccess(pair.refreshToken)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(tokens.verifyRefresh(pair.accessToken)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a tampered token', async () => {
    const token = await tokens.signAccess({ sub: 'user-4', role: 'USER' });
    const [h, , s] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ sub: 'user-4', role: 'SUPER_ADMIN', typ: 'access' }),
    ).toString('base64url');
    await expect(tokens.verifyAccess(`${h}.${forged}.${s}`)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects an expired token', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const token = await tokens.signAccess({ sub: 'user-5', role: 'USER' }, 60);
    vi.advanceTimersByTime(61_000);
    await expect(tokens.verifyAccess(token)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('keeps impersonation claims', async () => {
    const token = await tokens.signAccess({
      sub: 'owner-1',
      role: 'USER',
      impersonatedBy: 'admin-1',
      workspaceId: 'ws-1',
    });
    await expect(tokens.verifyAccess(token)).resolves.toMatchObject({
      impersonatedBy: 'admin-1',
      workspaceId: 'ws-1',
    });
  });
});
