import { randomUUID } from 'node:crypto';
import { ExportError, requireThat } from '../diagnostics/errors';
import { json, record, string } from '../validate';

export const SERVICE = 'https://api2.cursor.sh';
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
export class HttpError extends ExportError {
  constructor(readonly status: number) { super(status === 401 || status === 403 ? 'auth' : 'unavailable', status === 401 || status === 403 ? 'Sign-in expired or access was denied. Run the command again to sign in.' : `The source returned HTTP ${status}. No response content was logged.`); }
}
export async function delay(ms: number, signal: AbortSignal) {
  if (signal.aborted) throw new ExportError('cancelled', 'Export cancelled.');
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(new ExportError('cancelled', 'Export cancelled.')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
export class Http {
  constructor(private fetcher: Fetcher = fetch, private pause = delay) {}
  async bytes(url: string, init: RequestInit, signal: AbortSignal): Promise<Uint8Array> {
    for (let attempt = 0; attempt < 4; attempt++) {
      if (signal.aborted) throw new ExportError('cancelled', 'Export cancelled.');
      try {
        const response = await this.fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) });
        if (response.status === 429 || [502, 503, 504].includes(response.status)) {
          await response.body?.cancel().catch(() => {});
          if (attempt === 3) throw new HttpError(response.status);
          const retry = response.headers.get('retry-after');
          const wait = retry && /^\d+$/.test(retry) ? Number(retry) * 1000 : 500 * 2 ** attempt;
          await this.pause(Math.min(wait, 30_000), signal); continue;
        }
        if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new HttpError(response.status); }
        requireThat(!response.redirected, 'unavailable', 'Unexpected source redirect.');
        const reader = response.body?.getReader();
        requireThat(reader, 'schema', 'Missing response body.');
        const chunks: Uint8Array[] = []; let length = 0;
        try {
          while (true) {
            const { done, value } = await reader.read(); if (done) break;
            length += value.byteLength;
            requireThat(length <= 64 * 1024 * 1024, 'coverage', 'A response exceeded the resource limit. Export is incomplete.');
            chunks.push(value);
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        return Buffer.concat(chunks, length);
      } catch (error) {
        if (signal.aborted) throw new ExportError('cancelled', 'Export cancelled.');
        if (error instanceof ExportError) throw error;
        if (attempt === 3) throw new ExportError('unavailable', 'A source request failed or timed out.');
        await this.pause(500 * 2 ** attempt, signal);
      }
    }
    throw new ExportError('unavailable', 'Source unavailable.');
  }
  async json(url: string, init: RequestInit, signal: AbortSignal) { return json(await this.bytes(url, init, signal)); }
}
const METHODS = new Set(['ListGrokBotAgents', 'ListGrokBotAgentSessions', 'ListGrokBotTranscriptEntries', 'PresignSandBoxStoreReads', 'GetSandBoxRunState', 'EnsureSandBox']);
export function endpoint(value: unknown): URL {
  const s = string(value); let u: URL;
  try { u = new URL(s); } catch { throw new ExportError('schema', 'Invalid source endpoint.'); }
  requireThat(u.protocol === 'https:' && !u.username && !u.password && !u.port && !u.hash && !u.hostname.endsWith('.') &&
    /^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/i.test(u.hostname) && !/(^|\.)(localhost|local|internal|test|invalid)$/.test(u.hostname), 'schema', 'Untrusted source endpoint.');
  return u;
}
export class Service {
  #token: string;
  constructor(token: string, readonly http = new Http()) { this.#token = token; }
  close() { this.#token = ''; }
  async rpc(method: string, payload: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
    requireThat(METHODS.has(method), 'schema', 'Source method is outside the read allowlist.');
    requireThat(method !== 'EnsureSandBox' || JSON.stringify(payload) === '{"wake":false}', 'schema', 'Only non-waking connection establishment is allowed.');
    requireThat(this.#token, 'auth', 'Sign-in is required.');
    return record(await this.http.json(`${SERVICE}/aiserver.v1.GrokBotService/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1',
        Authorization: `Bearer ${this.#token}`, 'x-cursor-client-type': 'sand', 'x-cursor-client-source': 'sand-desktop',
        'x-cursor-client-version': '0.44.0', 'x-sand-box-namespace': 'prod', 'x-request-id': randomUUID() }, body: JSON.stringify(payload),
    }, signal));
  }
}
