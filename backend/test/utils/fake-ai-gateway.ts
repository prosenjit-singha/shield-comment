import type { Mock } from 'vitest';
import type {
  AiConnectionTestResult,
  AiGatewayService,
  ChatResult,
} from '../../src/ai-gateway/ai-gateway.service.js';

type Fn<K extends keyof AiGatewayService> = AiGatewayService[K] extends (
  ...args: infer A
) => infer R
  ? (...args: A) => R
  : never;

type Armed = { reply: ChatResult } | { error: Error };

export interface FakeAiGateway {
  enabled: boolean;
  isConfigured: Mock<Fn<'isConfigured'>>;
  chat: Mock<Fn<'chat'>>;
  testConnection: Mock<Fn<'testConnection'>>;
  replyWith(reply: string | Partial<ChatResult>): FakeAiGateway;
  failWith(error: Error): FakeAiGateway;
  /** Arms one `testConnection` answer (a result, or an error it throws). */
  connectionResult(result: AiConnectionTestResult | Error): FakeAiGateway;
  /** Armed `chat` + `testConnection` answers not used yet. */
  readonly pending: number;
  reset(): void;
}

/**
 * Strict stand-in for `AiGatewayService` in e2e specs (no live LLM call, M5-T1). `chat` throws
 * `Unexpected AiGatewayService.chat call` unless armed: each `replyWith` / `failWith` answers
 * exactly one call, in order. `testConnection` is just as strict: each `connectionResult`
 * answers one probe (M5-T2). Flip `enabled` to test "not configured" (`isConfigured`).
 * Wire it with `.overrideProvider(AiGatewayService).useValue(fakeAiGateway())`.
 */
export function fakeAiGateway(): FakeAiGateway {
  const queue: Armed[] = [];
  const probes: (AiConnectionTestResult | Error)[] = [];
  const fake: FakeAiGateway = {
    enabled: true,
    isConfigured: vi.fn<Fn<'isConfigured'>>(async () => fake.enabled),
    chat: vi.fn<Fn<'chat'>>(async () => {
      const next = queue.shift();
      if (!next) {
        throw new Error('Unexpected AiGatewayService.chat call in this spec');
      }
      if ('error' in next) throw next.error;
      return next.reply;
    }),
    testConnection: vi.fn<Fn<'testConnection'>>(async () => {
      const next = probes.shift();
      if (!next) {
        throw new Error(
          'Unexpected AiGatewayService.testConnection call in this spec',
        );
      }
      if (next instanceof Error) throw next;
      return next;
    }),
    /** Arms one successful reply (`content` string or a partial result). */
    replyWith(reply: string | Partial<ChatResult>): FakeAiGateway {
      const partial = typeof reply === 'string' ? { content: reply } : reply;
      queue.push({
        reply: {
          provider: 'neon',
          model: 'gpt-oss-20b',
          content: '',
          latencyMs: 1,
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          ...partial,
        },
      });
      return fake;
    },
    /** Arms one failure (e.g. `new AiGatewayError('rate_limited', …)`). */
    failWith(error: Error): FakeAiGateway {
      queue.push({ error });
      return fake;
    },
    connectionResult(result: AiConnectionTestResult | Error): FakeAiGateway {
      probes.push(result);
      return fake;
    },
    /** Armed answers not used yet (assert `0` at the end of a spec). */
    get pending(): number {
      return queue.length + probes.length;
    },
    reset(): void {
      queue.length = 0;
      probes.length = 0;
      fake.testConnection.mockClear();
      fake.enabled = true;
      fake.chat.mockClear();
      fake.isConfigured.mockClear();
    },
  };
  return fake;
}
