import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { count, eq, inArray } from 'drizzle-orm';
import type { App } from 'supertest/types.js';
import type { Test } from 'supertest';
import {
  ticketAttachments,
  tickets,
  type TicketStatus,
} from '../src/db/schema/index.js';
import { StorageService } from '../src/storage/storage.service.js';
import type { AttachmentView } from '../src/support-tickets/ticket-attachments.js';
import { type Actor, createAuthActors } from './utils/auth-actors.js';
import { createTestApp } from './utils/create-test-app.js';
import { createStorageFake } from './utils/fake-storage.js';

interface Message {
  id: string;
  body: string;
  isInternalNote?: boolean;
  attachments: AttachmentView[];
}
interface Thread {
  id: string;
  status: TicketStatus;
  messages: Message[];
}

const MB = 1024 * 1024;
const png = (size = 64) => {
  const b = Buffer.alloc(size);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  return b;
};
const jpeg = () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const webp = () =>
  Buffer.concat([
    Buffer.from('RIFF'),
    Buffer.alloc(4),
    Buffer.from('WEBPVP8 '),
    Buffer.alloc(8),
  ]);

type File = [Buffer, string, string];
const PNG: File = [png(), 'shot.png', 'image/png'];
const JPEG: File = [jpeg(), 'shot.jpg', 'image/jpeg'];
const WEBP: File = [webp(), 'shot.webp', 'image/webp'];

/**
 * M7-T3: ticket screenshots (D4: ≤ 3 PNG/JPEG/WebP ≤ 5 MB per message, client + admin), stored
 * through a strict in-memory `StorageService` fake, shown as presigned URLs.
 */
describe('Ticket attachments (e2e)', () => {
  let app: INestApplication<App>;
  let actors: ReturnType<typeof createAuthActors>;
  const storage = createStorageFake();
  const http = () => actors.http();
  const db = () => actors.db;
  const T = `m7t3${randomBytes(4).toString('hex')}`;

  let superAdmin: Actor;
  let a: Actor;
  let mod: Actor;
  let b: Actor;

  const base = (ws: string) => `/api/workspaces/${ws}/support/tickets`;
  const withFiles = (req: Test, files: File[]) =>
    files.reduce(
      (r, [buf, filename, contentType]) =>
        r.attach('files', buf, { filename, contentType }),
      req,
    );
  const createMultipart = (
    actor: Actor,
    files: File[],
    subject = 'with files',
    ws = actor.workspaceId,
  ) =>
    withFiles(
      http()
        .post(base(ws))
        .set('Cookie', actor.cookie)
        .field('category', 'TECHNICAL')
        .field('subject', `${T} ${subject}`)
        .field('body', 'See the screenshot'),
      files,
    );
  const replyMultipart = (
    actor: Actor,
    ticketId: string,
    files: File[],
    ws = actor.workspaceId,
  ) =>
    withFiles(
      http()
        .post(`${base(ws)}/${ticketId}/reply`)
        .set('Cookie', actor.cookie)
        .field('body', 'More screenshots'),
      files,
    );
  const adminMultipart = (ticketId: string, files: File[], note: boolean) =>
    withFiles(
      http()
        .post(`/api/admin/tickets/${ticketId}/reply`)
        .set('Cookie', superAdmin.cookie)
        .field('body', note ? 'Internal: look at this' : 'Here is the fix')
        .field('isInternalNote', String(note)),
      files,
    );
  const clientThread = async (actor: Actor, id: string) =>
    (
      await http()
        .get(`${base(actor.workspaceId)}/${id}`)
        .set('Cookie', actor.cookie)
        .expect(200)
    ).body as Thread;
  const adminThread = async (id: string) =>
    (
      await http()
        .get(`/api/admin/tickets/${id}`)
        .set('Cookie', superAdmin.cookie)
        .expect(200)
    ).body as Thread;
  const newTicket = async (actor: Actor, subject: string) =>
    (
      await http()
        .post(base(actor.workspaceId))
        .set('Cookie', actor.cookie)
        .send({ category: 'OTHER', subject: `${T} ${subject}`, body: 'Help' })
        .expect(201)
    ).body as Thread;
  const ticketCount = async (actor: Actor) =>
    (
      await db()
        .select({ n: count() })
        .from(tickets)
        .where(eq(tickets.workspaceId, actor.workspaceId))
    )[0]!.n;
  const expectNothingStored = () => {
    expect(storage.unexpected).toEqual([]);
    expect(storage.pendingPuts).toBe(0);
  };
  const urlOf = (key: string) =>
    `https://storage.test/${key}?X-Amz-Expires=900`;

  beforeAll(async () => {
    app = await createTestApp((builder) =>
      builder.overrideProvider(StorageService).useValue(storage),
    );
    actors = createAuthActors(app);
    superAdmin = await actors.signUpSuperAdmin('m7t3-super');
    a = await actors.signUp('m7t3-a');
    mod = await actors.signUp('m7t3-mod');
    b = await actors.signUp('m7t3-b');
    await actors.addMember(a.workspaceId, mod.id, 'moderator');
  });

  beforeEach(() => {
    storage.enabled = true;
  });

  afterEach(() => {
    expect(storage.unexpected).toEqual([]);
    storage.unexpected.length = 0;
  });

  afterAll(async () => {
    await actors?.cleanup();
    await app?.close();
  });

  it('client create with 2 images: stored under tickets/<ticket>/<message>/, thread shows 2 presigned urls', async () => {
    storage.expectPuts(2);
    const res = await createMultipart(a, [PNG, WEBP]).expect(201);
    const created = res.body as Thread;
    const [first] = created.messages;
    expect(first!.body).toBe('See the screenshot');
    expect(first!.attachments).toHaveLength(2);
    expect(first!.attachments.map((x) => [x.contentType, x.sizeBytes])).toEqual(
      [
        ['image/png', PNG[0].length],
        ['image/webp', WEBP[0].length],
      ],
    );

    const rows = await db()
      .select()
      .from(ticketAttachments)
      .where(eq(ticketAttachments.ticketId, created.id));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.messageId).toBe(first!.id);
      expect(row.storageKey).toMatch(
        new RegExp(
          `^tickets/${created.id}/${first!.id}/[0-9a-f-]{36}\\.(png|webp)$`,
        ),
      );
      expect(storage.objects.get(row.storageKey)?.contentType).toBe(
        row.contentType,
      );
    }
    const thread = await clientThread(a, created.id);
    expect(
      thread.messages[0]!.attachments.map((x) => x.url!).sort((p, q) =>
        p.localeCompare(q),
      ),
    ).toEqual(
      rows.map((r) => urlOf(r.storageKey)).sort((p, q) => p.localeCompare(q)),
    );
    expect((await adminThread(created.id)).messages[0]!.attachments).toEqual(
      thread.messages[0]!.attachments,
    );
    expectNothingStored();
  });

  it('admin reply with an image + an internal note with an image: the client sees only the reply’s', async () => {
    const t = await newTicket(a, 'admin images');
    storage.expectPuts(2);
    const reply = (await adminMultipart(t.id, [JPEG], false).expect(201))
      .body as { message: Message; ticket: { status: TicketStatus } };
    expect(reply.message.isInternalNote).toBe(false);
    expect(reply.message.attachments).toHaveLength(1);
    expect(reply.ticket.status).toBe('IN_PROGRESS');
    const note = (await adminMultipart(t.id, [PNG], true).expect(201)).body as {
      message: Message;
    };
    expect(note.message.isInternalNote).toBe(true);
    expect(note.message.attachments).toHaveLength(1);

    const admin = await adminThread(t.id);
    expect(admin.messages.map((m) => m.attachments.length)).toEqual([0, 1, 1]);

    const client = await clientThread(a, t.id);
    expect(client.messages.map((m) => m.body)).toEqual([
      'Help',
      'Here is the fix',
    ]);
    expect(client.messages[1]!.attachments).toEqual(reply.message.attachments);
    expect(JSON.stringify(client)).not.toContain(
      note.message.attachments[0]!.id,
    );
    expectNothingStored();
  });

  it('client reply with an image (JPEG); a JSON reply still works and has attachments: []', async () => {
    const t = await newTicket(a, 'client reply');
    storage.expectPuts(1);
    const res = await replyMultipart(a, t.id, [JPEG]).expect(201);
    expect((res.body as { message: Message }).message.attachments).toEqual([
      expect.objectContaining({ contentType: 'image/jpeg' }),
    ]);
    const json = await http()
      .post(`${base(a.workspaceId)}/${t.id}/reply`)
      .set('Cookie', a.cookie)
      .send({ body: 'plain' })
      .expect(201);
    expect((json.body as { message: Message }).message.attachments).toEqual([]);
    expectNothingStored();
  });

  describe('refused before anything is written', () => {
    it('4 files → 400 ATTACHMENT_TOO_MANY', async () => {
      const before = await ticketCount(a);
      const res = await createMultipart(a, [PNG, PNG, PNG, PNG]).expect(400);
      expect(res.body.code).toBe('ATTACHMENT_TOO_MANY');
      expect(await ticketCount(a)).toBe(before);
      expectNothingStored();
    });

    it('6 MB → 400 ATTACHMENT_TOO_LARGE', async () => {
      const before = await ticketCount(a);
      const res = await createMultipart(a, [
        [png(6 * MB), 'big.png', 'image/png'],
      ]).expect(400);
      expect(res.body.code).toBe('ATTACHMENT_TOO_LARGE');
      expect(await ticketCount(a)).toBe(before);
      expectNothingStored();
    });

    it('a .png that is really text → 400 ATTACHMENT_TYPE_INVALID (also a JPEG labelled PNG, a GIF)', async () => {
      const t = await newTicket(a, 'bad types');
      const before = await ticketCount(a);
      for (const file of [
        [Buffer.from('not an image at all'), 'fake.png', 'image/png'],
        [jpeg(), 'mislabelled.png', 'image/png'],
        [Buffer.from('GIF89a......'), 'anim.gif', 'image/gif'],
      ] as File[]) {
        const res = await createMultipart(a, [file]).expect(400);
        expect(res.body.code).toBe('ATTACHMENT_TYPE_INVALID');
        const admin = await adminMultipart(t.id, [file], false).expect(400);
        expect(admin.body.code).toBe('ATTACHMENT_TYPE_INVALID');
      }
      expect(await ticketCount(a)).toBe(before);
      expect((await adminThread(t.id)).messages).toHaveLength(1);
      expectNothingStored();
    });

    it('storage not configured → 409 ATTACHMENTS_UNAVAILABLE on create and both replies; JSON still works; old images read as url null', async () => {
      storage.expectPuts(1);
      const withImage = (
        await createMultipart(a, [PNG], 'before outage').expect(201)
      ).body as Thread;
      storage.enabled = false;
      const before = await ticketCount(a);
      const res = await createMultipart(a, [PNG]).expect(409);
      expect(res.body.code).toBe('ATTACHMENTS_UNAVAILABLE');
      expect(await ticketCount(a)).toBe(before);
      expect(
        (await replyMultipart(a, withImage.id, [PNG]).expect(409)).body.code,
      ).toBe('ATTACHMENTS_UNAVAILABLE');
      expect(
        (await adminMultipart(withImage.id, [PNG], true).expect(409)).body.code,
      ).toBe('ATTACHMENTS_UNAVAILABLE');
      expect((await adminThread(withImage.id)).messages).toHaveLength(1);

      await newTicket(a, 'json while storage is off');
      const thread = await clientThread(a, withImage.id);
      expect(thread.messages[0]!.attachments).toEqual([
        expect.objectContaining({ contentType: 'image/png', url: null }),
      ]);
      expect(
        (await adminThread(withImage.id)).messages[0]!.attachments[0]!.url,
      ).toBeNull();
      expectNothingStored();
    });

    it('impersonated multipart create/reply → 403 IMPERSONATION_READ_ONLY', async () => {
      const t = await newTicket(a, 'impersonated');
      const cookie = await actors.signIn(a.email);
      await actors.patchStoredSession(cookie, {
        impersonatedBy: superAdmin.id,
        activeOrganizationId: a.workspaceId,
      });
      const as = { ...a, cookie };
      expect((await createMultipart(as, [PNG]).expect(403)).body.code).toBe(
        'IMPERSONATION_READ_ONLY',
      );
      expect(
        (await replyMultipart(as, t.id, [PNG]).expect(403)).body.code,
      ).toBe('IMPERSONATION_READ_ONLY');
      expectNothingStored();
    });

    it("moderator on the owner's ticket, another workspace's ticket, unknown admin ticket → 404", async () => {
      const t = await newTicket(a, 'visibility');
      await replyMultipart(mod, t.id, [PNG], a.workspaceId).expect(404);
      await replyMultipart(b, t.id, [PNG]).expect(404);
      await adminMultipart(
        '019a0000-0000-7000-8000-00000000dead',
        [PNG],
        false,
      ).expect(404);
      expect((await adminThread(t.id)).messages).toHaveLength(1);
      expectNothingStored();
    });

    it('cap of 20 unresolved still wins: 409 TICKET_LIMIT_REACHED before any upload', async () => {
      await db()
        .insert(tickets)
        .values(
          Array.from({ length: 20 }, (_, i) => ({
            workspaceId: b.workspaceId,
            userId: b.id,
            subject: `${T} seed ${i}`,
            category: 'OTHER' as const,
          })),
        );
      const res = await createMultipart(b, [PNG]).expect(409);
      expect(res.body.code).toBe('TICKET_LIMIT_REACHED');
      expect(await ticketCount(b)).toBe(20);
      expectNothingStored();
    });
  });

  it('every attachment row belongs to a tracked ticket (cleanup removes them)', async () => {
    const ids = (
      await db()
        .select({ id: tickets.id })
        .from(tickets)
        .where(inArray(tickets.workspaceId, [a.workspaceId, b.workspaceId]))
    ).map((r) => r.id);
    const [n] = await db()
      .select({ n: count() })
      .from(ticketAttachments)
      .where(inArray(ticketAttachments.ticketId, ids));
    expect(n!.n).toBe(storage.objects.size);
  });
});
