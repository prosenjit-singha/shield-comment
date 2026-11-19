import { Module } from '@nestjs/common';
import { WalletService } from './wallet.service.js';

/**
 * The client wallet (PW-T2, PW-D3/D4). No routes: `WalletService` is used by the moderation
 * worker from PW-T4 and the billing APIs from PW-T6. Drizzle comes from the global `DbModule`.
 */
@Module({
  providers: [WalletService],
  exports: [WalletService],
})
export class WalletModule {}
