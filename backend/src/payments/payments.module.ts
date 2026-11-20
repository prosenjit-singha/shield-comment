import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createSslcommerzConfig,
  SSLCOMMERZ_CONFIG,
  SslcommerzClient,
} from './sslcommerz.client.js';

/** SSLCommerz payments (Module 8). Billing rows import it for checkout + IPN validation. */
@Module({
  providers: [
    {
      provide: SSLCOMMERZ_CONFIG,
      inject: [ConfigService],
      useFactory: createSslcommerzConfig,
    },
    SslcommerzClient,
  ],
  exports: [SSLCOMMERZ_CONFIG, SslcommerzClient],
})
export class PaymentsModule {}
