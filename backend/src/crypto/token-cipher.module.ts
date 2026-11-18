import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTokenKeyring, TOKEN_KEYRING } from './token-cipher.config.js';
import { TokenCipherService } from './token-cipher.service.js';

/** AES-256-GCM token cipher. No HTTP routes; feature modules import this and inject `TokenCipherService`. */
@Module({
  providers: [
    {
      provide: TOKEN_KEYRING,
      inject: [ConfigService],
      useFactory: createTokenKeyring,
    },
    TokenCipherService,
  ],
  exports: [TokenCipherService],
})
export class TokenCipherModule {}
