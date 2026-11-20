import { createServer, type Server } from 'node:http';

/**
 * Tiny Meta Graph stand-in for the Module 6 gate (D17 a). `backend-e2e` sends its Graph calls here
 * (`META_GRAPH_BASE_URL`). It answers only the comment hide/unhide form post the executor makes
 * (`POST /<version>/<comment-id>`, `is_hidden=true|false`) with `{ success: true }`; anything else is
 * recorded and answered 404, so the test fails on unexpected calls.
 * Listens on all interfaces: the backend container reaches it via host.docker.internal (host runs)
 * or the `e2e` service alias (Docker runs).
 */
export interface GraphCall {
  method: string;
  path: string;
  form: Record<string, string>;
  expected: boolean;
}

export interface GraphStub {
  calls: GraphCall[];
  close(): Promise<void>;
}

const HIDE_PATH = /^\/v\d+\.\d+\/\d{1,32}(_\d{1,32}){0,2}$/;

export async function startGraphStub(port: number): Promise<GraphStub> {
  const calls: GraphCall[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const path = new URL(req.url ?? '/', 'http://stub').pathname;
      const form = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
      const expected =
        req.method === 'POST' &&
        HIDE_PATH.test(path) &&
        (form.is_hidden === 'true' || form.is_hidden === 'false') &&
        typeof form.access_token === 'string';
      calls.push({ method: req.method ?? '', path, form, expected });
      res.writeHead(expected ? 200 : 404, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(
          expected ? { success: true } : { error: { message: 'Unexpected call to the e2e Graph stub', code: 803 } },
        ),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', resolve);
  });
  return {
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
