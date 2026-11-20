import type { Mock } from 'vitest';
import type {
  EmailMessage,
  EmailSendResult,
  EmailService,
} from '../../src/email/email.service.js';

export interface FakeEmailService {
  enabled: boolean;
  send: Mock<EmailService['send']>;
  /** Sends that were armed and answered, in order. */
  readonly sent: EmailMessage[];
  /** Sends nobody armed (each also threw); assert it stays empty. */
  readonly unexpected: EmailMessage[];
  /** Arms `count` successful sends (ids `fake-email-1`, `-2`, …). */
  expectSends(count?: number): FakeEmailService;
  /** Arms one send that throws `error` (e.g. a retryable `EmailSendError`). */
  failNext(error: Error): FakeEmailService;
  /** Armed answers not used yet. */
  readonly pending: number;
  reset(): void;
}

/**
 * Strict stand-in for `EmailService` (M7-T1): no network, and a send nobody armed throws
 * `Unexpected EmailService.send` (and lands in `unexpected`, in case the caller swallows errors).
 * Wire it with `.overrideProvider(EmailService).useValue(createEmailServiceFake())`.
 */
export function createEmailServiceFake(): FakeEmailService {
  const armed: (Error | null)[] = [];
  const sent: EmailMessage[] = [];
  const unexpected: EmailMessage[] = [];
  let ids = 0;
  const fake: FakeEmailService = {
    enabled: true,
    send: vi.fn<EmailService['send']>(
      async (message): Promise<EmailSendResult> => {
        if (armed.length === 0) {
          unexpected.push(message);
          throw new Error(
            `Unexpected EmailService.send in this spec (subject ${JSON.stringify(message.subject)})`,
          );
        }
        const error = armed.shift();
        if (error) throw error;
        sent.push(message);
        ids += 1;
        return { delivered: true, id: `fake-email-${ids}` };
      },
    ),
    sent,
    unexpected,
    expectSends(count = 1) {
      for (let i = 0; i < count; i += 1) armed.push(null);
      return fake;
    },
    failNext(error) {
      armed.push(error);
      return fake;
    },
    get pending() {
      return armed.length;
    },
    reset() {
      armed.length = 0;
      sent.length = 0;
      unexpected.length = 0;
      ids = 0;
      fake.send.mockClear();
    },
  };
  return fake;
}
