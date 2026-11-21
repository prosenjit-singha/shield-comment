import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { env } from './env.js';

/**
 * SSLCommerz stand-in for the Module 8 gate (D13 a). `backend-e2e` sends its SSLCommerz calls here
 * (`SSLCOMMERZ_BASE_URL`). It answers only:
 * - the Session API (`POST /gwprocess/v4/api.php`, the store's id + password) → `GatewayPageURL` =
 *   this stub's `/gateway/<tran_id>` page;
 * - the Order Validation API (`GET /validator/api/validationserverAPI.php?val_id=VAL-<tran_id>`) →
 *   VALID with the session's amount (or `chargeAmount()`'s, the tamper case);
 * - `GET /gateway/<tran_id>` (the browser): a "Pay" button that POSTs the signed return form to the
 *   session's `success_url`, like the real hosted page.
 * Anything else is recorded and answered 404, so the test fails on unexpected calls.
 * Listens on all interfaces: the backend container reaches it via host.docker.internal (host runs)
 * or the `e2e` service alias (Docker runs); the browser runs next to it (localhost).
 */
export interface SslcommerzCall {
  method: string;
  path: string;
  kind: 'session' | 'validation' | 'gateway' | 'unexpected';
}

export interface SslcommerzStub {
  calls: SslcommerzCall[];
  /** Session forms by `tran_id`. */
  sessions: Map<string, Record<string, string>>;
  /** The validator answers `amount` for this `tran_id` instead of the session's. */
  chargeAmount(tranId: string, amount: number): void;
  close(): Promise<void>;
}

export const SESSION_PATH = '/gwprocess/v4/api.php';
export const VALIDATION_PATH = '/validator/api/validationserverAPI.php';
const GATEWAY_PATH = /^\/gateway\/([A-Za-z0-9_-]{8,30})$/;
const CARD_TYPE = 'BKASH-BKash';

const md5 = (value: string) => createHash('md5').update(value).digest('hex');
const valIdOf = (tranId: string) => `VAL-${tranId}`;

/** A callback form as SSLCommerz signs it: md5 over the `verify_key` fields + md5(store password), sorted. */
export function signedForm(fields: Record<string, string>): Record<string, string> {
  const all: Record<string, string> = { ...fields, store_passwd: md5(env.sslcommerzStore.password) };
  const hash = Object.keys(all)
    .sort()
    .map((key) => `${key}=${all[key]}`)
    .join('&');
  return { ...fields, verify_key: Object.keys(fields).join(','), verify_sign: md5(hash) };
}

/** The IPN / success-return body for a paid `tran_id`. */
export function paidForm(tranId: string, amountBdt: number): Record<string, string> {
  return signedForm({
    status: 'VALID',
    tran_id: tranId,
    val_id: valIdOf(tranId),
    amount: `${amountBdt}.00`,
    currency: 'BDT',
    card_type: CARD_TYPE,
  });
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export async function startSslcommerzStub(port: number): Promise<SslcommerzStub> {
  const calls: SslcommerzCall[] = [];
  const sessions = new Map<string, Record<string, string>>();
  const charged = new Map<string, number>();
  const store = env.sslcommerzStore;

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://stub');
      const method = req.method ?? '';
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const record = (kind: SslcommerzCall['kind']) => calls.push({ method, path: url.pathname, kind });
      const storeOk = (p: { get(key: string): string | null | undefined }) =>
        p.get('store_id') === store.id && p.get('store_passwd') === store.password;

      if (method === 'POST' && url.pathname === SESSION_PATH) {
        const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        const tranId = form.get('tran_id');
        if (storeOk(form) && tranId && form.get('currency') === 'BDT' && form.get('success_url')) {
          record('session');
          sessions.set(tranId, Object.fromEntries(form));
          return json(200, {
            status: 'SUCCESS',
            GatewayPageURL: `http://localhost:${port}/gateway/${tranId}`,
            sessionkey: `E2E${tranId}`,
          });
        }
      }

      if (method === 'GET' && url.pathname === VALIDATION_PATH && storeOk(url.searchParams)) {
        const tranId = url.searchParams.get('val_id')?.replace(/^VAL-/, '') ?? '';
        const session = sessions.get(tranId);
        if (session && url.searchParams.get('format') === 'json') {
          record('validation');
          const amount = `${charged.get(tranId) ?? Number(session.total_amount)}.00`;
          return json(200, {
            status: 'VALID',
            tran_id: tranId,
            val_id: valIdOf(tranId),
            amount,
            currency_type: 'BDT',
            currency_amount: amount,
            bank_tran_id: `BANK-${tranId}`,
            card_type: CARD_TYPE,
            risk_level: '0',
          });
        }
      }

      const gateway = GATEWAY_PATH.exec(url.pathname);
      const session = gateway?.[1] ? sessions.get(gateway[1]) : undefined;
      if (method === 'GET' && gateway?.[1] && session?.success_url) {
        record('gateway');
        const fields = paidForm(gateway[1], Number(session.total_amount));
        const inputs = Object.entries(fields)
          .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
          .join('');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(
          `<!doctype html><title>SSLCommerz (e2e stub)</title><h1>Pay ৳${escapeHtml(session.total_amount ?? '')}</h1>` +
            `<form method="post" action="${escapeHtml(session.success_url)}">${inputs}<button>Pay</button></form>`,
        );
        return;
      }

      record('unexpected');
      json(404, { status: 'FAILED', failedreason: 'Unexpected call to the e2e SSLCommerz stub' });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', resolve);
  });
  return {
    calls,
    sessions,
    chargeAmount: (tranId, amount) => charged.set(tranId, amount),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
