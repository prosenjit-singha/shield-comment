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
  /**
   * Answers the next send to `to` (delivered) without arming, recorded in `allowed` only: the
   * sign-up verification email of `createAuthActors().signUp` (M9-T5). Cleared by `reset()`.
   */
  allow(to: string): FakeEmailService;
  readonly allowed: EmailMessage[];
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
  const allowedTo = new Set<string>(); // one send each
  const allowed: EmailMessage[] = [];
  let ids = 0;
  const fake: FakeEmailService = {
    enabled: true,
    send: vi.fn<EmailService['send']>(
      async (message): Promise<EmailSendResult> => {
        if (allowedTo.delete(message.to)) {
          allowed.push(message);
          return { delivered: true, id: `fake-allowed-${allowed.length}` };
        }
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
    allowed,
    allow(to) {
      allowedTo.add(to);
      return fake;
    },
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
      allowedTo.clear();
      allowed.length = 0;
      ids = 0;
      fake.send.mockClear();
    },
  };
  return fake;
}

/** The `?token=` of the CTA link to `path` (e.g. `/verify-email`, `/reset-password`) in a sent email. */
export function linkToken(message: EmailMessage, path: string): string {
  const match = new RegExp(`${path}\\?token=([^\\s"&]+)`).exec(message.text);
  expect(match, `${path} link in "${message.subject}"`).not.toBeNull();
  return decodeURIComponent(match![1]!);
}
