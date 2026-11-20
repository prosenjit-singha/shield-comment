import type { INestApplication } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { App } from 'supertest/types.js';
import { workspaceMembers } from '../src/db/schema/index.js';
import { EmailService, EmailSendError } from '../src/email/email.service.js';
import { type Actor, createAuthActors } from './utils/auth-actors.js';
import { createTestApp } from './utils/create-test-app.js';
import {
  createEmailServiceFake,
  type FakeEmailService,
} from './utils/fake-email.js';

const CLIENT_APP_URL = 'http://app.localhost:5174';

/** M7-T4 (D5 a): the requester gets one email per public admin reply; nothing else emails. */
describe('Ticket reply email (e2e)', () => {
  let app: INestApplication<App>;
  let actors: ReturnType<typeof createAuthActors>;
  let email: FakeEmailService;
  const http = () => actors.http();

  let superAdmin: Actor;
  let owner: Actor;
  let mod: Actor;

  /** Every ticket lives in the owner's workspace (the moderator is a member there). */
  const newTicket = async (actor: Actor, subject: string) =>
    (
      await http()
        .post(`/api/workspaces/${owner.workspaceId}/support/tickets`)
        .set('Cookie', actor.cookie)
        .send({ category: 'BILLING', subject, body: 'Help' })
        .expect(201)
    ).body as { id: string };
  const adminReply = (id: string, body: string, isInternalNote = false) =>
    http()
      .post(`/api/admin/tickets/${id}/reply`)
      .set('Cookie', superAdmin.cookie)
      .send({ body, isInternalNote })
      .expect(201);
  /** `emitReplied` doesn't await listeners: give a skipped/ignored send time to happen. */
  const settle = () => new Promise((r) => setTimeout(r, 100));

  beforeAll(async () => {
    email = createEmailServiceFake();
    app = await createTestApp((b) =>
      b.overrideProvider(EmailService).useValue(email),
    );
    actors = createAuthActors(app);
    superAdmin = await actors.signUpSuperAdmin('m7t4-super');
    owner = await actors.signUp('m7t4-owner');
    mod = await actors.signUp('m7t4-mod');
    await actors.addMember(owner.workspaceId, mod.id, 'moderator');
  });

  afterEach(() => {
    expect(email.unexpected).toEqual([]);
    expect(email.pending).toBe(0);
    email.reset();
  });

  afterAll(async () => {
    await actors?.cleanup();
    await app?.close();
  });

  it('public admin reply → exactly one email to the requester with the thread link, no reply text', async () => {
    const t = await newTicket(mod, 'Refund for order 42');
    email.expectSends(1);
    const res = await adminReply(t.id, 'SECRET reply text');
    await vi.waitFor(() => expect(email.sent).toHaveLength(1));
    await settle();
    const [sent] = email.sent;
    expect(sent).toMatchObject({
      to: mod.email,
      subject: expect.stringContaining(
        'New reply to your support ticket: Refund for order 42',
      ),
      idempotencyKey: `ticket-reply:${(res.body as { message: { id: string } }).message.id}`,
    });
    expect(sent!.text).toContain(`${CLIENT_APP_URL}/support?ticket=${t.id}`);
    expect(sent!.html).toContain(`${CLIENT_APP_URL}/support?ticket=${t.id}`);
    expect(sent!.text).not.toContain('SECRET');
    expect(sent!.html).not.toContain('SECRET');
    expect(sent!.text).not.toContain(superAdmin.email);
  });

  it('internal note and client reply → no email', async () => {
    const t = await newTicket(owner, 'Notes only');
    await adminReply(t.id, 'note', true);
    await http()
      .post(
        `/api/workspaces/${owner.workspaceId}/support/tickets/${t.id}/reply`,
      )
      .set('Cookie', owner.cookie)
      .send({ body: 'More info' })
      .expect(201);
    await settle();
    expect(email.send).not.toHaveBeenCalled();
  });

  it('email failure → admin reply still 201, nothing retried', async () => {
    const t = await newTicket(owner, 'Failing email');
    email.failNext(new EmailSendError('Resend 500: down', 500, true));
    await adminReply(t.id, 'Answer');
    await vi.waitFor(() => expect(email.send).toHaveBeenCalledTimes(1));
    await settle();
    expect(email.send).toHaveBeenCalledTimes(1);
    expect(email.sent).toEqual([]);
  });

  it('requester no longer a workspace member → no email', async () => {
    const t = await newTicket(mod, 'Left the team');
    await actors.db
      .delete(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, owner.workspaceId),
          eq(workspaceMembers.userId, mod.id),
        ),
      );
    await adminReply(t.id, 'Answer');
    await settle();
    expect(email.send).not.toHaveBeenCalled();
  });
});
