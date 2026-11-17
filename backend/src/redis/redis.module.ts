import { Global, Module } from '@nestjs/common';
import { authSecondaryStorageProvider, AUTH_SECONDARY_STORAGE } from './redis-secondary-storage.js';
import { RedisService } from './redis.service.js';

@Global()
@Module({
  providers: [RedisService, authSecondaryStorageProvider],
  exports: [RedisService, AUTH_SECONDARY_STORAGE],
})
export class RedisModule {}
