import { EmailSendError } from '../../src/email/email.service.js';
import { createEmailServiceFake } from './fake-email.js';

const MESSAGE = { to: 'a@b.com', subject: 'Hi', html: '<p>Hi</p>', text: 'Hi' };

describe('createEmailServiceFake', () => {
  it('throws on a send nobody armed and records it', async () => {
    const fake = createEmailServiceFake();
    await expect(fake.send(MESSAGE)).rejects.toThrow(
      'Unexpected EmailService.send',
    );
    expect(fake.unexpected).toEqual([MESSAGE]);
    expect(fake.sent).toEqual([]);
  });

  it('answers armed sends and failures once each, in order', async () => {
    const error = new EmailSendError('Resend 503: HTTP 503', 503, true);
    const fake = createEmailServiceFake().expectSends(1).failNext(error);
    expect(fake.pending).toBe(2);
    await expect(fake.send(MESSAGE)).resolves.toEqual({
      delivered: true,
      id: 'fake-email-1',
    });
    await expect(fake.send(MESSAGE)).rejects.toBe(error);
    expect(fake.sent).toEqual([MESSAGE]);
    expect(fake.pending).toBe(0);
    fake.reset();
    expect(fake.sent).toEqual([]);
    expect(fake.send).not.toHaveBeenCalled();
  });
});
