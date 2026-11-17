import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createStorageTarget, STORAGE_TARGET } from './storage.config.js';
import { StorageService } from './storage.service.js';

/** Neon Object Storage. No HTTP routes yet; feature modules import this and inject `StorageService`. */
@Module({
  providers: [
    {
      provide: STORAGE_TARGET,
      inject: [ConfigService],
      useFactory: createStorageTarget,
    },
    StorageService,
  ],
  exports: [StorageService],
})
export class StorageModule {}
