import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { RolesGuard } from './guards/roles.guard.js';
import { SuperAdminGuard } from './guards/super-admin.guard.js';
import { PasswordService } from './password.service.js';
import { TokenService } from './token.service.js';

/**
 * Legacy JWT guards (`JwtAuthGuard`, `RolesGuard`), kept until SW-T3 ports them to Better Auth
 * sessions. Sign-up / sign-in now live in Better Auth (`src/auth/better-auth.ts`).
 */
@Module({
  // Secrets/TTLs are passed per call by TokenService, so access and refresh never share a key.
  imports: [JwtModule.register({})],
  providers: [
    PasswordService,
    TokenService,
    // Secure by default: every route needs a valid access token unless marked @Public().
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // Order matters: RolesGuard reads the user that JwtAuthGuard attached.
    { provide: APP_GUARD, useClass: RolesGuard },
    SuperAdminGuard,
  ],
  exports: [PasswordService, TokenService, SuperAdminGuard],
})
export class AuthModule {}
