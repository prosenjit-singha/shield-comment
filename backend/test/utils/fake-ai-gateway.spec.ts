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
});
