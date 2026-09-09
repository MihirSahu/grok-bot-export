import { describe, expect, test } from 'bun:test';
import { unionRoster } from '../src/source/discovery';
import { Http, Service } from '../src/source/http';
import { login } from '../src/source/auth';
import { scanHistory, resolveBody, readStableHistory } from '../src/source/history';
import { rawRow } from '../src/normalize/messages';
import { BrowserSource } from '../src/source/browser';
import { diagnostic } from '../src/diagnostics/errors';
import { hash, json, uint64 } from '../src/validate';
import { agent, body, c, paginated, row, signal } from './fixtures';

describe('discovery', () => {
  test('unions exact gateway id and server agentId without record-id substitution', () => {
    const bots = unionRoster([{ id: 'a', name: 'Same' }, { id: 'b', name: 'Same', isHiddenFromSidebar: true }], 2,
      [{ id: 'record-1', agentId: 'a', legacyAgentId: 'wrong', name: 'Same' }, { id: 'record-2', agentId: 'c', name: 'Only central' }]);
    expect(bots.map(b => b.id)).toEqual(['a', 'b', 'c']); expect(bots[1]!.hidden).toBe(true);
  });
  for (const [label, g, count, server] of [
    ['missing id', [{}], 1, []], ['wrong count', [{ id: 'a' }], 2, []],
    ['duplicate', [{ id: 'a' }, { id: 'a' }], 2, []], ['record fallback', [], 0, [{ id: 'record-only' }]],
    ['metadata conflict', [{ id: 'a', name: 'A' }], 1, [{ agentId: 'a', name: 'B' }]],
  ] as const) test(`rejects ${label}`, () => expect(() => unionRoster(g, count, server)).toThrow());
});

describe('raw history', () => {
  test('1,203 rows, uint64 sequences, and text-free pages reach the oldest raw boundary', async () => {
    const rows = Array.from({ length: 1203 }, (_, i) => row(i, i >= 1000 ? { kind: 'event' } : {}, 9007199254740993n));
    const calls: Record<string, unknown>[] = [];
    const h = await scanHistory(paginated(rows, p => calls.push(p)), c, [agent], signal(), 37);
    expect(h.rawCount).toBe(1203); expect(h.messages).toHaveLength(1000); expect(h.exclusions.event).toBe(203);
    expect(h.oldestSequence).toBe('9007199254740994'); expect(h.messages[0]!.entryId).toBe('entry-0');
    expect(calls.length).toBe(34); expect(h.messages.at(-1)!.sourceOrder).toBe(999);
  });
  for (const [name, patch] of [
    ['streaming', { isStreaming: true }], ['unknown row', { kind: 'future-visible' }], ['unknown typed body', { kind: 'send-message', message: { type: 'future-text', content: 'visible' } }],
    ['bad timestamp', { timestampMs: 0 }], ['bad surrogate', { content: '\ud800' }], ['uncertain speaker', { authorId: 'someone-else' }],
  ] as const) test(`fails ${name} instead of dropping text`, async () => {
    expect(scanHistory(paginated([row(0, patch)]), c, [agent], signal())).rejects.toThrow();
  });
  test('raw identity mismatch fails', async () => {
    const r = row(0); r.entryId = 'wrong'; await expect(scanHistory(paginated([r]), c, [agent], signal())).rejects.toThrow('identity');
  });
  test('repeated cursor and changed generation fail', async () => {
    let calls = 0;
    const transport = { rpc: async () => ({ generation: ++calls, entries: [row(0)] }), blob: async () => new Uint8Array() };
    await expect(scanHistory(transport, c, [agent], signal())).rejects.toThrow('generation');
    transport.rpc = async () => ({ generation: 1, entries: [row(0)] });
    await expect(scanHistory(transport, c, [agent], signal())).rejects.toThrow('cursor');
  });
  test('empty text is an exported message and unknown timestamps remain undated', async () => {
    const h = await scanHistory(paginated([row(0, { content: '', timestampMs: null })]), c, [agent], signal());
    expect(h.messages[0]!.content).toBe(''); expect(h.messages[0]!.timestamp).toBeNull();
  });
  test('omitted bodies require exact version identity', async () => {
    const r = rawRow({ ...row(0), body: undefined, bodyOmitted: true });
    expect(await resolveBody(paginated([row(0)]), r, c, 1, signal())).toEqual(body(0));
    const changed = row(0); changed.updatedSeq = '2';
    await expect(resolveBody(paginated([changed]), r, c, 1, signal())).rejects.toThrow('changed');
  });
  test('signed blob bodies are hash verified and untrusted origins refused', async () => {
    const bytes = Buffer.from(JSON.stringify(body(0))), digest = hash(bytes).slice(7);
    const r = rawRow({ ...row(0), body: undefined, blobHash: digest }); let fetched = '';
    const transport = { rpc: async () => ({ instructions: [{ relPath: `blobs/${digest}`, url: 'https://bucket.s3.amazonaws.com/object?signature=synthetic' }] }), blob: async (url: string) => { fetched = url; return bytes; } };
    expect(await resolveBody(transport, r, c, 1, signal())).toEqual(body(0)); expect(fetched).toContain('s3.amazonaws.com');
    transport.blob = async () => Buffer.from('corrupt'); await expect(resolveBody(transport, r, c, 1, signal())).rejects.toThrow('hash');
    transport.rpc = async () => ({ instructions: [{ relPath: `blobs/${digest}`, url: 'https://untrusted.example/object' }] });
    await expect(resolveBody(transport, r, c, 1, signal())).rejects.toThrow('origin');
  });
  test('unsafe numbers and duplicate JSON keys fail', () => {
    expect(() => uint64(9007199254740992)).toThrow(); expect(() => uint64('18446744073709551616')).toThrow();
    expect(() => json('{"kind":"message","kind":"event"}')).toThrow();
  });
  test('raw fingerprints cover excluded records as well as visible text', async () => {
    const a = await scanHistory(paginated([row(0, { kind: 'event', event: { type: 'start' } })]), c, [agent], signal());
    const b = await scanHistory(paginated([row(0, { kind: 'event', event: { type: 'stop' } })]), c, [agent], signal());
    expect(a.exclusions).toEqual(b.exclusions); expect(a.messages).toEqual(b.messages); expect(a.rawFingerprint).not.toBe(b.rawFingerprint);
  });
  test('streaming text gets bounded retries without becoming a partial success', async () => {
    let attempts = 0;
    const p = paginated([row(0, { isStreaming: true })], () => attempts++);
    await expect(readStableHistory(p, c, [agent], signal(), async () => {})).rejects.toThrow('streaming'); expect(attempts).toBe(3);
  });
});

describe('authentication and HTTP isolation', () => {
  test('retries interrupted response bodies from scratch', async () => {
    let calls = 0; const waits: number[] = [];
    const http = new Http(async () => {
      if (++calls > 1) return Response.json({ complete: true });
      let reads = 0;
      return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
        if (++reads === 1) controller.enqueue(Buffer.from('{"partial":'));
        else controller.error(new Error('synthetic connection reset'));
      } }));
    }, async ms => { waits.push(ms); });
    expect(await http.json('https://api2.cursor.sh/test', {}, signal())).toEqual({ complete: true });
    expect(calls).toBe(2); expect(waits).toEqual([500]);
  });
  test('exhausted response-body retries report source failure without remote details', async () => {
    let calls = 0;
    const http = new Http(async () => {
      calls++;
      return new Response(new ReadableStream({ start(controller) { controller.error(new Error('SECRET BODY')); } }));
    }, async () => {});
    try { await http.bytes('https://api2.cursor.sh/test', {}, signal()); throw new Error('missing failure'); }
    catch (e) { expect(diagnostic(e)).toStartWith('unavailable:'); expect(diagnostic(e)).not.toContain('SECRET'); }
    expect(calls).toBe(4);
  });
  test('response-body cancellation does not retry or report a filesystem failure', async () => {
    let calls = 0; const abort = new AbortController();
    const http = new Http(async () => {
      calls++;
      return new Response(new ReadableStream({ pull(controller) { abort.abort(); controller.error(new Error('aborted')); } }));
    }, async () => { throw new Error('must not retry'); });
    try { await http.bytes('https://api2.cursor.sh/test', {}, abort.signal); throw new Error('missing failure'); }
    catch (e) { expect(diagnostic(e)).toStartWith('cancelled:'); }
    expect(calls).toBe(1);
  });
  test('oversized response bodies remain coverage failures without retries', async () => {
    let calls = 0;
    const http = new Http(async () => {
      calls++;
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(64 * 1024 * 1024 + 1)); controller.close(); } }));
    }, async () => { throw new Error('must not retry'); });
    try { await http.bytes('https://api2.cursor.sh/test', {}, signal()); throw new Error('missing failure'); }
    catch (e) { expect(diagnostic(e)).toStartWith('coverage:'); }
    expect(calls).toBe(1);
  });
  test('bounded retry, request cancellation, and redacted remote errors', async () => {
    let calls = 0; const waits: number[] = [];
    const http = new Http(async (_url, init) => { expect(init.redirect).toBe('error'); calls++; return calls < 3 ? new Response('private text', { status: 429, headers: { 'retry-after': '1' } }) : Response.json({ ok: true }); }, async ms => { waits.push(ms); });
    expect(await http.json('https://api2.cursor.sh/test', {}, signal())).toEqual({ ok: true }); expect(waits).toEqual([1000, 1000]);
    const bad = new Http(async () => new Response('SECRET BODY', { status: 403 }));
    try { await bad.json('https://api2.cursor.sh/test', {}, signal()); throw new Error('missing failure'); } catch (e) { expect(diagnostic(e)).not.toContain('SECRET'); }
    const aborted = new AbortController(); aborted.abort(); await expect(http.json('https://api2.cursor.sh/test', {}, aborted.signal)).rejects.toThrow('cancelled');
  });
  test('browser PKCE keeps token and verifier off the browser URL', async () => {
    const claims = Buffer.from(JSON.stringify({ sub: 'synthetic-account', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
    const token = `eyJhbGciOiJub25lIn0.${claims}.synthetic`; let browser = '', poll = '';
    const http = new Http(async url => { poll = url; return Response.json({ accessToken: token }); });
    const result = await login(signal(), async url => { browser = url; }, http);
    expect(result.accountId).toBe('synthetic-account'); expect(browser).toContain('challenge='); expect(browser).not.toContain('verifier'); expect(browser).not.toContain(token);
    expect(new URL(poll).origin).toBe('https://api2.cursor.sh'); expect(new URL(poll).searchParams.get('verifier')!.length).toBeGreaterThan(40);
  });
  test('service mutations and wake requests are denied before network access', async () => {
    let called = false; const service = new Service('synthetic', new Http(async () => { called = true; return Response.json({}); }));
    await expect(service.rpc('SendPrompt', {}, signal())).rejects.toThrow('allowlist');
    await expect(service.rpc('EnsureSandBox', { wake: true }, signal())).rejects.toThrow('non-waking'); expect(called).toBe(false);
    service.close(); await expect(service.rpc('ListGrokBotAgents', {}, signal())).rejects.toThrow('Sign-in');
  });
  test('browser adapter returns observed coverage after two matching scans without asserting atomic completeness', async () => {
    const token = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ sub: c.accountId, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.synthetic`;
    const calls: string[] = [];
    const http = new Http(async (url, init) => {
      calls.push(url); const u = new URL(url), headers = new Headers(init.headers);
      if (u.pathname === '/auth/poll') return Response.json({ accessToken: token });
      if (u.hostname === 'gateway.example.com') {
        expect(headers.get('authorization')).toBe('Bearer gateway-only'); expect(headers.get('x-anyrun-network-token')).toBe('network-only');
        return Response.json(u.pathname.endsWith('countAgents') ? 1 : [{ id: c.agentId, name: c.agentName }]);
      }
      expect(headers.get('authorization')).toBe(`Bearer ${token}`); expect(headers.has('x-anyrun-network-token')).toBe(false);
      if (u.pathname.endsWith('GetSandBoxRunState')) return Response.json({ state: 3 });
      if (u.pathname.endsWith('EnsureSandBox')) { expect(init.body).toBe('{"wake":false}'); return Response.json({ gatewayUrl: 'https://gateway.example.com', gatewayToken: 'gateway-only', networkToken: 'network-only' }); }
      if (u.pathname.endsWith('ListGrokBotAgents')) return Response.json({ agents: [{ id: 'record-only', agentId: c.agentId, name: c.agentName }] });
      if (u.pathname.endsWith('ListGrokBotAgentSessions')) return Response.json({ sessions: [] });
      if (u.pathname.endsWith('ListGrokBotTranscriptEntries')) return Response.json({ entries: [], generation: 1 });
      throw new Error('unexpected network route');
    });
    const source = new BrowserSource(async () => {}, () => {}, http);
    const snapshot = await source.snapshot(signal()); source.close();
    expect(snapshot.certificate.consistency).toBe('matching-full-account-scans');
    expect(snapshot.certificate.inventoryComplete).toBe(false);
    expect(snapshot.certificate.retentionBoundaryVerified).toBe(false);
    expect(calls.filter(x => x.endsWith('ListGrokBotTranscriptEntries')).length).toBe(2);
  });
});
