import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface TelegramStubMessage {
  chatId: number;
  text: string;
}

/**
 * Bot API stub on 127.0.0.1 (random port): answers only `POST /bot<token>/sendMessage` with
 * `{ ok: true }` and records it; anything else gets 404 and lands in `unexpected` (assert it empty).
 */
export async function startTelegramStub(botToken: string) {
  const sent: TelegramStubMessage[] = [];
  const unexpected: string[] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'POST' && req.url === `/bot${botToken}/sendMessage`) {
        const body = JSON.parse(raw) as { chat_id: number; text: string };
        sent.push({ chatId: body.chat_id, text: body.text });
        res.end(
          JSON.stringify({ ok: true, result: { message_id: sent.length } }),
        );
        return;
      }
      unexpected.push(`${req.method} ${req.url}`);
      res.statusCode = 404;
      res.end(
        JSON.stringify({
          ok: false,
          error_code: 404,
          description: 'Not Found',
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    sent,
    unexpected,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
