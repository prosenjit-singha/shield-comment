import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import {
  validateEnv,
  type EnvironmentVariables,
} from './config/env.validation.js';
import { AuthModule } from './auth/auth.module.js';
import { HealthModule } from './health/health.module.js';
import { isHealthProbe } from './health/health-probe.js';
import { redactRequestSerializer } from './common/logging/redact-query.js';
import { DbModule } from './db/db.module.js';
import { RedisModule } from './redis/redis.module.js';
import { QueueModule } from './queue/queue.module.js';
import { StorageModule } from './storage/storage.module.js';
import { AiGatewayModule } from './ai-gateway/ai-gateway.module.js';
import { AdminModule } from './admin/admin.module.js';
import { MeModule } from './me/me.module.js';
import { MetaModule } from './meta/meta.module.js';
import { SupportTicketsModule } from './support-tickets/support-tickets.module.js';
import { WorkspacesModule } from './workspaces/workspaces.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvironmentVariables, true>) => {
        const isDev = config.get('NODE_ENV', { infer: true }) === 'development';
        return {
          pinoHttp: {
            level: config.get('LOG_LEVEL', { infer: true }),
            redact: ['req.headers.authorization', 'req.headers.cookie'],
            autoLogging: { ignore: (req) => isHealthProbe(req.url) },
            // OAuth `code`/`state` in callback URLs never reach the logs (M3-T4).
            serializers: { req: redactRequestSerializer },
            transport: isDev
              ? { target: 'pino-pretty', options: { singleLine: true } }
              : undefined,
          },
        };
      },
    }),
    DbModule,
    RedisModule,
    QueueModule,
    AuthModule,
    HealthModule,
    StorageModule,
    AiGatewayModule,
    MeModule,
    WorkspacesModule,
    AdminModule,
    SupportTicketsModule,
    MetaModule,
  ],
})
export class AppModule {}
