import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { uuidv7 } from 'uuidv7';
import { AiGatewayModule } from '../ai-gateway/ai-gateway.module.js';
import { AiGatewayService } from '../ai-gateway/ai-gateway.service.js';
import { relaxHappyEyeballsTimeout } from '../common/net/happy-eyeballs.js';
import { validateEnv } from '../config/env.validation.js';
import { DbModule } from '../db/db.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { StorageService } from '../storage/storage.service.js';

/**
 * End-to-end check of the Neon services the backend uses besides Postgres:
 * object storage (put → get → presigned GET → delete → get null) and one AI gateway call.
 * Run: `npm run build && npm run neon:smoke:production` (or `:staging`; `.env` → `.env.<branch>` → `.env.local`,
 * behind the Neon branch guard). Exit 1 on any failure.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    // The AI config resolver reads the admin settings (M5-T3) before falling back to env.
    DbModule,
    StorageModule,
    AiGatewayModule,
  ],
})
class SmokeModule {}

type Step = { name: string; ok: boolean; detail: string };

async function storageSmoke(storage: StorageService): Promise<Step[]> {
  if (!storage.enabled)
    return [{ name: 'storage', ok: false, detail: 'not configured' }];
  const key = `smoke/${uuidv7()}.txt`;
  const payload = `shield-comment neon smoke ${new Date().toISOString()}`;
  const steps: Step[] = [];
  const run = async (
    name: string,
    fn: () => Promise<string>,
  ): Promise<boolean> => {
    try {
      steps.push({ name, ok: true, detail: await fn() });
      return true;
    } catch (error) {
      steps.push({
        name,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  };
  const put = await run('storage.put', async () => {
    await storage.put(key, payload, {
      contentType: 'text/plain; charset=utf-8',
    });
    return `bucket=${storage.bucket} key=${key} bytes=${Buffer.byteLength(payload)}`;
  });
  if (!put) return steps;
  await run('storage.get', async () => {
    const obj = await storage.get(key);
    const text = obj ? Buffer.from(obj.body).toString('utf8') : null;
    if (text !== payload) throw new Error(`read back mismatch: ${text}`);
    return `round-trip ok, contentType=${obj?.contentType}`;
  });
  await run('storage.presignGet', async () => {
    const url = await storage.presignGet(key, 60);
    const res = await fetch(url);
    const text = await res.text();
    if (!res.ok || text !== payload) throw new Error(`HTTP ${res.status}`);
    return `HTTP ${res.status} via presigned URL (no credentials)`;
  });
  await run('storage.delete', async () => {
    await storage.delete(key);
    const gone = await storage.get(key);
    if (gone) throw new Error('object still exists after delete');
    return 'deleted, get → null';
  });
  return steps;
}

async function aiSmoke(ai: AiGatewayService): Promise<Step> {
  if (!(await ai.isConfigured()))
    return { name: 'ai.probe', ok: false, detail: 'not configured' };
  // The connection probe works for chat and System One (Jev) models alike.
  const res = await ai.testConnection();
  return {
    name: 'ai.probe',
    ok: res.ok,
    detail: res.ok
      ? `provider=${res.provider} model=${res.model} ms=${res.latencyMs}`
      : `kind=${res.kind}${res.message ? ` ${res.message}` : ''}`,
  };
}

relaxHappyEyeballsTimeout();
const app = await NestFactory.createApplicationContext(SmokeModule, {
  logger: ['error', 'warn'],
});
const steps = [
  ...(await storageSmoke(app.get(StorageService))),
  await aiSmoke(app.get(AiGatewayService)),
];
await app.close();
for (const s of steps)
  console.log(`${s.ok ? 'PASS' : 'FAIL'} ${s.name}: ${s.detail}`);
process.exit(steps.every((s) => s.ok) ? 0 : 1);
