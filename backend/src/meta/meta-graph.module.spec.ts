import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { MetaGraphClient } from './meta-graph.client.js';
import { MetaGraphModule } from './meta-graph.module.js';

async function resolveClient(env: Record<string, string>) {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        ignoreEnvVars: true,
        load: [() => env],
      }),
      MetaGraphModule,
    ],
  }).compile();
  return moduleRef.get(MetaGraphClient);
}

describe('MetaGraphModule', () => {
  it('provides a disabled client when the META_* app vars are unset', async () => {
    const client = await resolveClient({});
    expect(client.enabled).toBe(false);
  });

  it('provides an enabled client on the pinned version when configured', async () => {
    const client = await resolveClient({
      META_APP_ID: '1234567890',
      META_APP_SECRET: 'meta-app-secret-0123456789abcdef',
      META_LOGIN_CONFIG_ID: '987654321',
      META_OAUTH_REDIRECT_URI:
        'https://app.example.com/api/meta/oauth/callback',
    });
    expect(client.enabled).toBe(true);
    expect(client.graphApiVersion).toBe('v26.0');
  });
});
