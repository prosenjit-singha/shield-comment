import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createEmailSettings,
  EMAIL_SETTINGS,
  EmailService,
} from './email.service.js';

/** Transactional email (M7-T1, Resend). Global: tickets, invites and alerts inject `EmailService`. */
@Global()
@Module({
  providers: [
    {
      provide: EMAIL_SETTINGS,
      inject: [ConfigService],
      useFactory: createEmailSettings,
    },
    EmailService,
  ],
  exports: [EmailService],
})
export class EmailModule {}
