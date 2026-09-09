import type { Agent, Conversation, Message, Peer, Speaker } from '../model';
import { hash, integer, record, string, timestamp, uint64 } from '../validate';
import { requireThat } from '../diagnostics/errors';

export interface RawRow { seq: string; updatedSeq: string; entryKind: string; entryId?: string; body?: string; blobHash?: string; bodyOmitted: boolean }
export function rawRow(value: unknown): RawRow {
  const r = record(value);
  requireThat(r.bodyOmitted === undefined || typeof r.bodyOmitted === 'boolean', 'schema', 'Invalid body-omission marker.');
  return { seq: uint64(r.seq ?? '0'), updatedSeq: uint64(r.updatedSeq ?? '0'), entryKind: string(r.entryKind),
    ...(r.entryId === undefined ? {} : { entryId: string(r.entryId) }),
    ...(r.body === undefined ? {} : { body: string(r.body, true) }),
    ...(r.blobHash === undefined ? {} : { blobHash: string(r.blobHash) }), bodyOmitted: r.bodyOmitted === true };
}
const EXCLUDED = new Set(['spend-initiation', 'event', 'notice', 'tool-call', 'user-attachment', 'feedback']);
const EXCLUDED_SEND = new Set(['widget', 'connector', 'auto-review-approval']);

export function normalize(row: RawRow, value: unknown, c: Conversation, generation: number, roster: Agent[]): Message | string {
  const b = record(value), kind = string(b.kind), id = string(b.id);
  requireThat(kind === row.entryKind && (row.entryId === undefined || row.entryId === id), 'schema', 'Raw-row identity disagrees with decoded body.');
  if (EXCLUDED.has(kind)) return kind;
  requireThat(kind === 'message' || kind === 'send-message', 'schema', 'Unclassified transcript row; no records were silently omitted.');
  if (kind === 'send-message') {
    const m = record(b.message), type = string(m.type);
    if (EXCLUDED_SEND.has(type)) return `send-message/${type}`;
    requireThat(type === 'text', 'schema', 'Unclassified send-message body.');
  }
  for (const key of ['streaming', 'isStreaming']) {
    requireThat(b[key] === undefined || typeof b[key] === 'boolean', 'schema', 'Invalid streaming marker.');
    requireThat(b[key] !== true, 'consistency', 'A text message is still streaming. Retry when the conversation has settled.');
  }
  // These variants require a validated participant mapping; never guess You.
  requireThat(!['author', 'authorId', 'participantId', 'sender', 'senderId', 'userId', 'groupAuthor'].some(k => b[k] != null), 'schema', 'Unvalidated participant attribution.');
  const sourceRole = kind === 'message' ? string(b.role) : null;
  requireThat(sourceRole === null || sourceRole === 'user' || sourceRole === 'assistant', 'schema', 'Unsupported message role.');
  const role = sourceRole === 'user' ? 'user' : 'assistant';
  let speaker: Speaker = role === 'user' ? { kind: 'human', id: 'self' } : { kind: 'agent', id: c.agentId };
  let peer: Peer | null = null;
  requireThat(!(b.fromAgent != null && b.toAgent != null), 'schema', 'Ambiguous peer direction.');
  const direction = b.fromAgent != null ? 'from' : b.toAgent != null ? 'to' : null;
  if (direction) {
    const p = record(direction === 'from' ? b.fromAgent : b.toAgent);
    const peerId = string(p.id);
    const name = roster.find(a => a.id === peerId)?.name ?? (p.name === undefined ? 'Unnamed Agent' : string(p.name));
    peer = { direction, id: peerId, name };
    speaker = { kind: 'agent', id: direction === 'from' ? peerId : c.agentId };
  }
  requireThat(!roster.find(a => a.id === c.agentId)?.group || peer !== null, 'schema', 'Group speaker attribution requires validation.');
  const content = string(kind === 'message' ? b.content : record(b.message).content, true);
  return { entryId: id, role, content, timestamp: timestamp(b.timestampMs), sourceOrder: 0, sourceSchemaVersion: 1,
    sourceGeneration: integer(generation, 0xffffffff), sourceSequence: row.seq, sourceUpdatedSequence: row.updatedSeq,
    sourceKind: kind, sourceRole, speaker, peer, contentHash: hash(content) };
}
