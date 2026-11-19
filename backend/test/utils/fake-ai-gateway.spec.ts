import { AiGatewayError } from '../../src/ai-gateway/ai-gateway.errors.js';
import { fakeAiGateway } from './fake-ai-gateway.js';

const MESSAGES = [{ role: 'user' as const, content: 'x' }];

describe('fakeAiGateway', () => {
  it('throws on an unarmed chat call', async () => {
    const fake = fakeAiGateway();
    await expect(fake.chat(MESSAGES)).rejects.toThrow(
      'Unexpected AiGatewayService.chat call',
    );
  });

  it('answers each armed reply or error exactly once, in order', async () => {
    const error = new AiGatewayError('rate_limited', 'AI neon 429: slow down');
    const fake = fakeAiGateway()
      .replyWith('{"category":"SAFE_INQUIRY"}')
      .failWith(error);
    expect(fake.pending).toBe(2);
    await expect(fake.chat(MESSAGES)).resolves.toMatchObject({
      provider: 'neon',
      content: '{"category":"SAFE_INQUIRY"}',
    });
    await expect(fake.chat(MESSAGES)).rejects.toBe(error);
    await expect(fake.chat(MESSAGES)).rejects.toThrow('Unexpected');
    expect(fake.chat).toHaveBeenCalledTimes(3);
    expect(fake.pending).toBe(0);
  });

  it('reports enabled through isConfigured and resets', async () => {
    const fake = fakeAiGateway().replyWith({ content: 'a', model: 'm' });
    fake.enabled = false;
    await expect(fake.isConfigured()).resolves.toBe(false);
    fake.reset();
    expect(fake.pending).toBe(0);
    await expect(fake.isConfigured()).resolves.toBe(true);
  });

  it('throws on an unarmed testConnection call', async () => {
    const fake = fakeAiGateway().replyWith('chat only');
    await expect(fake.testConnection()).rejects.toThrow(
      'Unexpected AiGatewayService.testConnection call',
    );
  });

  it('answers each armed connection result exactly once', async () => {
    const boom = new Error('resolver down');
    const fake = fakeAiGateway()
      .connectionResult({
        ok: true,
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        latencyMs: 12,
      })
      .connectionResult({ ok: false, kind: 'auth', latencyMs: 3 })
      .connectionResult(boom);
    expect(fake.pending).toBe(3);
    await expect(fake.testConnection()).resolves.toMatchObject({
      ok: true,
      provider: 'anthropic',
    });
    await expect(fake.testConnection()).resolves.toEqual({
      ok: false,
      kind: 'auth',
      latencyMs: 3,
    });
    await expect(fake.testConnection()).rejects.toBe(boom);
    await expect(fake.testConnection()).rejects.toThrow('Unexpected');
    expect(fake.pending).toBe(0);
    fake.connectionResult({ ok: false, kind: 'timeout', latencyMs: 1 });
    fake.reset();
    expect(fake.pending).toBe(0);
    expect(fake.testConnection).not.toHaveBeenCalled();
  });
});
