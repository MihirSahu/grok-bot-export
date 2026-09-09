import { expect, test } from 'bun:test';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { exportSummary } from '../src/cli/main';
import { exportVault } from '../src/export/run';
import { planArchive, validateArchive } from '../src/export/archive';
import { scanTree } from '../src/export/filesystem';
import { publish, recover } from '../src/export/transaction';
import { certificate, parseManifest, parseNote, renderNote } from '../src/render/markdown';
import { BrowserSource } from '../src/source/browser';
import { Http } from '../src/source/http';
import { c, paginated, row, signal, workspace } from './fixtures';

/** Fictional source responses routed through the real browser adapter and publisher. */
function fixture() {
  const gateway = Array.from({ length: 5 }, (_, i) => ({ id: `bot-${i}`, name: `Bot ${i}`, harness: 'box' }));
  const token = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ sub: c.accountId, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.synthetic`;
  const heads: string[] = [];
  let fail = false;
  const http = new Http(async (url, init) => {
    const u = new URL(url), method = u.pathname.split('/').at(-1)!;
    const p = JSON.parse(String(init.body ?? '{}'));
    if (u.pathname === '/auth/poll') return Response.json({ accessToken: token });
    if (method === 'GetSandBoxRunState') return Response.json({ state: 3 });
    if (method === 'EnsureSandBox') return Response.json({ gatewayUrl: 'https://gateway.example.com', gatewayToken: 'gateway-only', networkToken: 'network-only' });
    if (method === 'countAgents') return Response.json(5);
    if (method === 'listAgents') return Response.json(gateway);
    if (method === 'ListGrokBotAgents') return Response.json({ agents: [{ ...gateway[0], id: 'central-record', agentId: 'bot-0' }] });
    if (method === 'ListGrokBotAgentSessions') return p.agentId === 'bot-0'
      ? Response.json({ sessions: [{ agentId: 'bot-0', sessionId: '', kind: 1 }, { agentId: 'bot-0', sessionId: 'extra', kind: 4 }] })
      : new Response('', { status: 404 });
    if (method === 'ListGrokBotTranscriptEntries') {
      if (fail && p.agentId === 'bot-4') return new Response('', { status: 403 });
      if (p.beforeSeq === undefined) heads.push(JSON.stringify([p.agentId, p.sessionId]));
      const rows = p.sessionId === 'extra' ? Array.from({ length: 650 }, (_, i) => row(i)) : [row(0), row(1), row(2), row(3, { kind: 'event' })];
      return Response.json(await paginated(rows).rpc(method, p, signal()));
    }
    throw new Error(`Unexpected synthetic route: ${method}`);
  });
  return { source: () => new BrowserSource(async () => {}, () => {}, http), heads, fail: () => { fail = true; } };
}

test('browser-to-vault export publishes all observed messages and explicit coverage gaps, then leaves unchanged bytes and mtimes', async () => {
  const w = workspace(), f = fixture();
  try {
    const plan = await exportVault(w.vault, f.source(), signal());
    expect(plan.conversations).toBe(6); expect(plan.messages).toBe(665); expect(plan.excluded).toBe(5);
    expect(plan.coverage).toBe('observed-retained-history'); expect(plan.unverifiedSessionInventories).toBe(4);
    expect(f.heads).toHaveLength(12); expect(f.heads.slice(0, 6)).toEqual(f.heads.slice(6));
    const manifest = parseManifest(readFileSync(join(w.root, '_export.md')));
    expect(manifest.certificate.consistency).toBe('matching-full-account-scans');
    expect(manifest.certificate.inventoryComplete).toBe(false);
    expect(manifest.certificate.retentionBoundaryVerified).toBe(false);
    if (manifest.certificate.consistency !== 'matching-full-account-scans') throw new Error('Expected observed certificate');
    expect(manifest.certificate.fullScanCount).toBe(2);
    expect(manifest.certificate.sessionCoverage.filter(s => s.scope === 'default-only-unverified').map(s => s.agentId)).toEqual(['bot-1', 'bot-2', 'bot-3', 'bot-4']);
    const bytes = readFileSync(join(w.root, '_export.md'), 'utf8');
    expect(bytes).toContain('other sessions may exist'); expect(bytes).not.toContain('complete-retained-history');
    const archive = validateArchive(scanTree(w.root).files);
    for (const note of archive.notes.values()) expect(note.coverage).toBe('observed-retained-history');
    const before = new Map([...archive.managed].map(([p, b]) => [p, { bytes: b, mtime: statSync(join(w.root, p)).mtimeMs }]));
    const again = await exportVault(w.vault, f.source(), signal());
    expect(again.created).toBe(0); expect(again.updated).toBe(0);
    for (const [p, old] of before) { expect(readFileSync(join(w.root, p)).equals(old.bytes)).toBe(true); expect(statSync(join(w.root, p)).mtimeMs).toBe(old.mtime); }
    const summary = exportSummary(plan);
    expect(summary).toContain('665 text messages'); expect(summary).toContain('4 bot session inventories unverified');
    expect(summary).not.toContain('Complete:'); expect(summary).not.toContain('boundary: verified');
    f.fail();
    await expect(exportVault(w.vault, f.source(), signal())).rejects.toThrow('access was denied');
    for (const [p, old] of before) { expect(readFileSync(join(w.root, p)).equals(old.bytes)).toBe(true); expect(statSync(join(w.root, p)).mtimeMs).toBe(old.mtime); }
  } finally { w.dispose(); }
});

test('observed metadata cannot certify completeness or omit a bot/session from its evidence', async () => {
  const w = workspace(), source = fixture().source();
  try {
    const value = await source.snapshot(signal());
    expect(() => certificate({ ...value.certificate, inventoryComplete: true })).toThrow('evidence');
    expect(() => certificate({ ...value.certificate, retentionBoundaryVerified: true })).toThrow('evidence');
    expect(() => certificate({ ...value.certificate, fullScanCount: 1 })).toThrow('evidence');
    if (value.certificate.consistency !== 'matching-full-account-scans') throw new Error('Expected observed certificate');
    const missing = structuredClone(value); if (missing.certificate.consistency !== 'matching-full-account-scans') throw new Error('Expected observed certificate');
    missing.certificate.sessionCoverage.pop();
    expect(() => planArchive(scanTree(w.root), missing)).toThrow('disagrees');
    value.certificate.sessionCoverage[0]!.sessionIds.pop();
    expect(() => planArchive(scanTree(w.root), value)).toThrow('disagrees');
  } finally { source.close(); w.dispose(); }
});

test('observed notes cannot disagree with manifest coverage, and observed transactions recover without source reads', async () => {
  const w = workspace(), source = fixture().source();
  try {
    const value = await source.snapshot(signal()), plan = planArchive(scanTree(w.root), value);
    const expected = new Map(plan.intended); // publish releases the plan's buffers after durable staging.
    const files = new Map(plan.intended);
    const path = [...files.keys()].find(p => p !== '_export.md')!, note = parseNote(files.get(path)!)!;
    files.set(path, renderNote({ ...note, coverage: 'complete-retained-history' }));
    expect(() => validateArchive(files)).toThrow('manifest coverage');
    expect(() => publish(w.root, plan, phase => { if (phase === 'note-published') throw new Error('synthetic interruption'); })).toThrow('synthetic interruption');
    source.close();
    expect(recover(w.root)).toBeGreaterThan(0);
    const archive = validateArchive(scanTree(w.root).files);
    expect(archive.manifest!.certificate.consistency).toBe('matching-full-account-scans');
    expect(archive.managed.size).toBe(expected.size);
    for (const [path, bytes] of expected) expect(archive.managed.get(path)).toEqual(bytes);
  } finally { source.close(); w.dispose(); }
});
