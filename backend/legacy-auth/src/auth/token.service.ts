import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { EnvironmentVariables } from '../config/env.validation.js';
import type {
  AccessTokenPayload,
  RefreshTokenPayload,
  TokenPair,
} from './auth.types.js';

const ALGORITHM = 'HS256';

@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService<EnvironmentVariables, true>,
  ) {}

  get accessTtl(): number {
    return this.config.get('JWT_ACCESS_TTL_SECONDS', { infer: true });
  }

  signAccess(
    claims: Omit<AccessTokenPayload, 'typ'>,
    expiresInSeconds = this.accessTtl,
  ): Promise<string> {
    return this.jwt.signAsync(
      { ...claims, typ: 'access' } satisfies AccessTokenPayload,
      {
        secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }),
        expiresIn: expiresInSeconds,
        algorithm: ALGORITHM,
      },
    );
  }

  signRefresh(userId: string): Promise<string> {
    return this.jwt.signAsync(
      { sub: userId, typ: 'refresh' } satisfies RefreshTokenPayload,
      {
        secret: this.config.get('JWT_REFRESH_SECRET', { infer: true }),
        expiresIn: this.config.get('JWT_REFRESH_TTL_SECONDS', { infer: true }),
        algorithm: ALGORITHM,
      },
    );
  }

  async issuePair(claims: Omit<AccessTokenPayload, 'typ'>): Promise<TokenPair> {
    const [accessToken, refreshToken] = await Promise.all([
      this.signAccess(claims),
      this.signRefresh(claims.sub),
    ]);
    return { accessToken, refreshToken, expiresIn: this.accessTtl };
  }

  verifyAccess(token: string): Promise<AccessTokenPayload> {
    return this.verify<AccessTokenPayload>(
      token,
      this.config.get('JWT_ACCESS_SECRET', { infer: true }),
      'access',
    );
  }

  verifyRefresh(token: string): Promise<RefreshTokenPayload> {
    return this.verify<RefreshTokenPayload>(
      token,
      this.config.get('JWT_REFRESH_SECRET', { infer: true }),
      'refresh',
    );
  }

  /** Any failure (bad signature, expired, wrong type) becomes a plain 401. */
  private async verify<T extends { typ: string }>(
    token: string,
    secret: string,
    typ: T['typ'],
  ): Promise<T> {
    let payload: T;
    try {
      payload = await this.jwt.verifyAsync<T>(token, {
        secret,
        algorithms: [ALGORITHM],
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
    if (payload.typ !== typ) {
      throw new UnauthorizedException('Invalid or expired token');
    }
    return payload;
  }
}
