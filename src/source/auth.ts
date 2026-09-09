import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { Http, HttpError, SERVICE, delay } from './http';
import { ExportError, requireThat } from '../diagnostics/errors';
import { json, record, string } from '../validate';

export interface Login { token: string; accountId: string }
export async function login(signal: AbortSignal, openBrowser: (url: string) => Promise<void>, http = new Http(), pause = delay): Promise<Login> {
  let verifier = randomBytes(32).toString('base64url');
  const uuid = randomUUID();
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const url = new URL('https://cursor.com/loginDeepControl');
  url.search = new URLSearchParams({ challenge, uuid, mode: 'login', redirectTarget: 'cli' }).toString();
  const controller = AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)]);
  try {
    await openBrowser(url.href);
    const poll = new URL(`${SERVICE}/auth/poll`);
    poll.search = new URLSearchParams({ uuid, verifier }).toString();
    for (let attempt = 0; attempt < 150; attempt++) {
      let data: Record<string, unknown>;
      try { data = record(await http.json(poll.href, { headers: { 'Content-Type': 'application/json' } }, controller)); }
      catch (e) {
        if (!(e instanceof HttpError) || e.status !== 404) throw e;
        await pause(Math.min(1000 * 1.2 ** attempt, 5000), controller); continue;
      }
      const token = string(data.accessToken);
      requireThat(/^eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token), 'auth', 'The browser sign-in returned an unsupported token format.');
      const claims = record(json(Buffer.from(token.split('.')[1]!, 'base64url')));
      requireThat(typeof claims.exp === 'number' && claims.exp * 1000 > Date.now() + 30_000, 'auth', 'The browser session has expired.');
      // Subject comes from a token received over provider TLS, never a pasted JWT.
      return { token, accountId: string(claims.sub) };
    }
    throw new ExportError('auth', 'Browser sign-in timed out. Run the command again.');
  } catch (e) {
    if (controller.aborted && !signal.aborted) throw new ExportError('auth', 'Browser sign-in timed out. Run the command again.');
    throw e;
  } finally { verifier = ''; }
}
