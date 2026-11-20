import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { EnvironmentVariables } from '../config/env.validation.js';
import type { Database } from '../db/database.js';
import { EmailSendError, type EmailService } from '../email/email.service.js';
import { TicketEvents, type TicketRepliedEvent } from './ticket-events.js';
import {
  ticketReplyEmail,
  TicketReplyNotifier,
} from './ticket-reply-notifier.js';

const TICKET = '019a0000-0000-7000-8000-000000000001';
const WS = '019a0000-0000-7000-8000-000000000002';
const MESSAGE = '019a0000-0000-7000-8000-0000000000ee';
const APP = 'https://app.shield.bd';
const SUBJECT = 'bKash payment <stuck>';

const adminReply: TicketRepliedEvent = {
  ticketId: TICKET,
  workspaceId: WS,
  messageId: MESSAGE,
  senderRole: 'ADMIN',
  isInternalNote: false,
};

interface Row {
  subject: string;
  email: string;
  banned: boolean;
  banExpires: Date | null;
  memberId: string | null;
}
const member: Row = {
  subject: SUBJECT,
  email: 'rahim@shop.bd',
  banned: false,
  banExpires: null,
  memberId: 'm1',
};

function setup(rows: Row[] | Error = [member]) {
  const select = vi.fn(() => chain);
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    leftJoin: () => chain,
    where: () => chain,
    limit: () =>
      rows instanceof Error ? Promise.reject(rows) : Promise.resolve(rows),
  };
  const send = vi.fn<EmailService['send']>(async () => ({
    delivered: true,
    id: 'e1',
  }));
  const events = new TicketEvents();
  const config = {
    get: () => APP,
  } as unknown as ConfigService<EnvironmentVariables, true>;
  const notifier = new TicketReplyNotifier(
    { select } as unknown as Database,
    events,
    { send } as unknown as EmailService,
    config,
  );
  return { notifier, events, select, send };
}

describe('ticketReplyEmail', () => {
  const email = ticketReplyEmail({ id: TICKET, subject: SUBJECT }, `${APP}/`);

  it('subject names the ticket in en + bn', () => {
    expect(email.subject).toBe(
      `New reply to your support ticket: ${SUBJECT} · আপনার সাপোর্ট টিকেটে নতুন উত্তর: ${SUBJECT}`,
    );
  });

  it('links to the thread on /support in both languages, escaped in html', () => {
    const link = `${APP}/support?ticket=${TICKET}`;
    expect(email.text.split(link)).toHaveLength(3);
    expect(email.html).toContain(`href="${link}"`);
    expect(email.html).toContain('bKash payment &lt;stuck&gt;');
    expect(email.text).toContain('View reply');
    expect(email.text).toContain('উত্তর দেখুন');
  });
});

describe('TicketReplyNotifier', () => {
  let log: ReturnType<typeof vi.spyOn>;
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('public admin reply → one email to the requester, no reply body, idempotency key', async () => {
    const { notifier, send } = setup();
    await expect(notifier.notify(adminReply)).resolves.toBe('sent');
    expect(send).toHaveBeenCalledTimes(1);
    const [message] = send.mock.calls[0]!;
    expect(message).toMatchObject({
      to: 'rahim@shop.bd',
      idempotencyKey: `ticket-reply:${MESSAGE}`,
      ...ticketReplyEmail({ id: TICKET, subject: SUBJECT }, APP),
    });
  });

  it.each([
    ['internal note', { isInternalNote: true }],
    ['client reply', { senderRole: 'CLIENT' as const }],
  ])('%s → nothing (no query, no send)', async (_, patch) => {
    const { notifier, select, send } = setup();
    await expect(notifier.notify({ ...adminReply, ...patch })).resolves.toBe(
      'ignored',
    );
    expect(select).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    ['skipped_ticket_missing', []],
    ['skipped_not_member', [{ ...member, memberId: null }]],
    ['skipped_banned', [{ ...member, banned: true }]],
    [
      'skipped_banned',
      [{ ...member, banned: true, banExpires: new Date(Date.now() + 60_000) }],
    ],
  ])('%s → no send, info log', async (outcome, rows) => {
    const { notifier, send } = setup(rows);
    await expect(notifier.notify(adminReply)).resolves.toBe(outcome);
    expect(send).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      { ticketId: TICKET, messageId: MESSAGE },
      `ticket reply email ${outcome}`,
    );
  });

  it('expired ban → sends', async () => {
    const { notifier } = setup([
      { ...member, banned: true, banExpires: new Date(Date.now() - 1) },
    ]);
    await expect(notifier.notify(adminReply)).resolves.toBe('sent');
  });

  it('not configured (dev/test) → resolves not_configured', async () => {
    const { notifier, send } = setup();
    send.mockResolvedValueOnce({ delivered: false, reason: 'not_configured' });
    await expect(notifier.notify(adminReply)).resolves.toBe('not_configured');
  });

  it('send failure is swallowed and logged without the recipient', async () => {
    const { notifier, send } = setup();
    send.mockRejectedValueOnce(
      new EmailSendError('Resend 500: boom', 500, true),
    );
    await expect(notifier.notify(adminReply)).resolves.toBe('failed');
    expect(warn).toHaveBeenCalledWith(
      { ticketId: TICKET, messageId: MESSAGE },
      'ticket reply email failed: EmailSendError: Resend 500: boom',
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('rahim@shop.bd');
  });

  it('DB failure is swallowed and logged', async () => {
    const { notifier, send } = setup(new Error('connection lost'));
    await expect(notifier.notify(adminReply)).resolves.toBe('failed');
    expect(send).not.toHaveBeenCalled();
  });

  it('subscribes on init and unsubscribes on destroy', async () => {
    const { notifier, events, send } = setup();
    notifier.onModuleInit();
    events.emitReplied(adminReply);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    notifier.onModuleDestroy();
    events.emitReplied(adminReply);
    await new Promise((r) => setImmediate(r));
    expect(send).toHaveBeenCalledTimes(1);
  });
});
