import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Agent, Conversation, History, Message, Snapshot, Source } from '../src/model';
import { hash } from '../src/validate';
import { canonicalRoot } from '../src/export/filesystem';
import type { HistoryTransport } from '../src/source/history';

export const c: Conversation = { accountId: 'synthetic-account', agentId: 'synthetic-agent', agentName: 'Researcher', sessionId: '', sessionName: '' };
export const agent: Agent = { id: c.agentId, name: c.agentName, group: false, hidden: false };
export const signal = () => new AbortController().signal;
export function message(n: number, options: Partial<Message> = {}): Message {
  const content = options.content ?? `Synthetic message ${n}`;
  return { entryId: `entry-${n}`, role: 'user', content, timestamp: '2026-09-07T19:03:00.000Z', sourceOrder: n,
    sourceSchemaVersion: 1, sourceGeneration: 1, sourceSequence: String(n + 1), sourceUpdatedSequence: String(n + 1),
    sourceKind: 'message', sourceRole: 'user', speaker: { kind: 'human', id: 'self' }, peer: null, ...options, contentHash: hash(content) };
}
export function history(messages = [message(0)], conversation = c): History {
  return { conversation: { ...conversation }, messages, rawCount: messages.length, exclusions: {}, generation: 1, rawFingerprint: hash(JSON.stringify(messages)),
    oldestSequence: messages[0]?.sourceSequence ?? null, newestSequence: messages.at(-1)?.sourceSequence ?? null,
    maxUpdatedSequence: messages.length ? String(messages.reduce((n, m) => BigInt(m.sourceUpdatedSequence) > n ? BigInt(m.sourceUpdatedSequence) : n, 0n)) : null, termination: 'empty-raw-page' };
}
export function snapshot(histories = [history()], agents = [agent]): Snapshot {
  return { accountId: c.accountId, agents: structuredClone(agents), histories: structuredClone(histories), certificate: {
    contract: 'SYNTHETIC-ONLY: immutable in-memory test data', consistency: 'immutable-snapshot', boundary: 'fixture-1', inventoryComplete: true, retentionBoundaryVerified: true,
  } };
}
export function source(value = snapshot()): Source { return { snapshot: async () => structuredClone(value), close() {} }; }
export function workspace() {
  const vault = mkdtempSync(join(tmpdir(), 'grok-vault-test-')), root = canonicalRoot(vault);
  return { vault, root, dispose: () => rmSync(vault, { recursive: true, force: true }) };
}
export function body(n: number, overrides: Record<string, unknown> = {}) { return { id: `entry-${n}`, kind: 'message', role: 'user', content: `Synthetic message ${n}`, timestampMs: 1788807780000, ...overrides }; }
export function row(n: number, overrides: Record<string, unknown> = {}, base = 0n) {
  const b = body(n, overrides);
  return { seq: String(base + BigInt(n + 1)), updatedSeq: String(base + BigInt(n + 1)), entryId: b.id, entryKind: b.kind, body: Buffer.from(JSON.stringify(b)).toString('base64') };
}
export function paginated(rows: ReturnType<typeof row>[], observe: (payload: Record<string, unknown>) => void = () => {}): HistoryTransport {
  return { rpc: async (method, p) => {
    if (method !== 'ListGrokBotTranscriptEntries') throw new Error('unexpected fixture method');
    observe(p);
    return { generation: 1, entries: rows.filter(r => p.beforeSeq === undefined || BigInt(r.seq) < BigInt(p.beforeSeq as string)).sort((a, b) => BigInt(a.seq) > BigInt(b.seq) ? -1 : 1).slice(0, p.limit as number) };
  }, blob: async () => { throw new Error('unexpected fixture storage request'); } };
}
