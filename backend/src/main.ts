import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import { relaxHappyEyeballsTimeout } from './common/net/happy-eyeballs.js';

async function bootstrap(): Promise<void> {
  relaxHappyEyeballsTimeout();
  // Body parsing is owned by the Better Auth integration (src/auth/auth.module.ts): it must see
  // the raw `/api/auth/*` stream and re-adds JSON/urlencoded parsing for every other route.
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    bodyParser: false,
  });
  app.useLogger(app.get(Logger));
  configureApp(app);
  app.enableShutdownHooks();

  await app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
}
await bootstrap();
