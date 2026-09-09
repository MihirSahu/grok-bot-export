import { parseDocument } from 'yaml';
import { coverageOf, type Certificate, type Conversation, type Coverage, type Message, type ObservedCertificate, type Peer, type Speaker, type VerifiedCertificate } from '../model';
import { array, compare, hash, integer, isHash, isoTimestamp, record, stable, string, timezone, uint64, utf8 } from '../validate';
import { requireThat } from '../diagnostics/errors';
import { conversationDirectory } from '../export/names';

export interface EntryIndex {
  id: string; role: Message['role']; source_kind: string; source_role: string | null;
  speaker: Speaker; peer: Peer | null; source_generation: number; source_sequence: string;
  source_updated_sequence: string; source_timestamp: string | null; archive_order: number;
  content_offset: number; content_bytes: number; content_hash: string;
}
export interface Note { conversation: Conversation; timezone: string; date: string | null; messages: Message[]; coverage?: Coverage }
export interface Inventory {
  account_id: string; agent_id: string; agent: string; session_id: string; session: string; directory: string;
  raw_count: number; exported_count: number; exclusions: Record<string, number>; generation: number; raw_fingerprint: string;
  oldest_sequence: string | null; newest_sequence: string | null; max_updated_sequence: string | null;
  termination: 'empty-raw-page';
}
export interface Manifest {
  account_id: string; archive_timezone: string; completed_at: string; certificate: Certificate;
  inventory: Inventory[];
}
const FIXED = { source: 'grok-bot', generated_by: 'grok-vault', format_version: 2 };
function document(meta: Record<string, unknown>, body: string): Buffer {
  const header = Object.entries(meta).map(([k, v]) => `${k}: ${JSON.stringify(v)}\n`).join('');
  const withoutHash = `---\n${header}---\n\n${body}`;
  return Buffer.from(`---\n${header}render_hash: ${JSON.stringify(hash(withoutHash))}\n---\n\n${body}`);
}
const dateFormatters = new Map<string, Intl.DateTimeFormat>();
export function dateParts(timestamp: string | null, zone: string): { date: string | null; time: string } {
  if (timestamp === null) return { date: null, time: 'Undated' };
  let formatter = dateFormatters.get(zone);
  if (!formatter) { formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone(zone), year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); dateFormatters.set(zone, formatter); }
  const parts = formatter.formatToParts(new Date(timestamp));
  const get = (type: string) => parts.find(p => p.type === type)!.value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
}
function heading(s: string): string { return string(s).replace(/[\r\n\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/[\\`*_{}\[\]()<>#+.!|~-]/g, '\\$&'); }
function speaker(m: Message, name: string): string {
  if (m.peer) return m.peer.direction === 'from' ? `From ${heading(m.peer.name)}` : `${heading(name)} → ${heading(m.peer.name)}`;
  return m.speaker.kind === 'human' && m.speaker.id === 'self' ? 'You' : heading(name);
}
export function renderNote(note: Note): Buffer {
  let bytes = 0; const chunks: string[] = [], index: EntryIndex[] = [];
  for (const m of note.messages) {
    string(m.content, true);
    const parts = dateParts(m.timestamp, note.timezone);
    requireThat(parts.date === note.date, 'schema', 'A message is assigned to the wrong archive date.');
    const prefix = `## ${parts.time} — ${speaker(m, note.conversation.agentName)}\n\n`;
    chunks.push(prefix, m.content, '\n\n'); bytes += Buffer.byteLength(prefix);
    index.push({ id: m.entryId, role: m.role, source_kind: m.sourceKind, source_role: m.sourceRole, speaker: m.speaker, peer: m.peer,
      source_generation: m.sourceGeneration, source_sequence: m.sourceSequence, source_updated_sequence: m.sourceUpdatedSequence,
      source_timestamp: m.timestamp, archive_order: m.sourceOrder, content_offset: bytes, content_bytes: Buffer.byteLength(m.content), content_hash: hash(m.content) });
    bytes += Buffer.byteLength(m.content) + 2;
  }
  const c = note.conversation;
  return document({ ...FIXED, account_id: c.accountId, agent_id: c.agentId, session_id: c.sessionId, coverage: note.coverage ?? 'complete-retained-history',
    agent: c.agentName, session: c.sessionName, date: note.date, archive_timezone: note.timezone, entry_index: index }, chunks.join(''));
}
export function renderManifest(m: Manifest): Buffer {
  const count = m.inventory.reduce((n, i) => n + i.exported_count, 0);
  let description = 'All retained text in the verified source snapshot is accounted for.\n';
  if (m.certificate.consistency === 'matching-full-account-scans') {
    const gaps = m.certificate.sessionCoverage.filter(s => s.scope === 'default-only-unverified');
    description = 'Two full-account scans matched, including all returned rows and repeated bot/session inventories. Each discovered conversation was paginated to an empty raw page.\n\n' +
      'This is an observed export. The service does not provide a verified atomic snapshot or a guarantee of complete retained-history coverage. Changes that occur and disappear between reads can go undetected.\n\n' +
      (gaps.length ? `Additional-session inventories could not be verified for ${gaps.length} bots. Their default histories were read, but other sessions may exist:\n\n` +
        gaps.map(s => `- ${heading(m.inventory.find(i => i.agent_id === s.agentId)?.agent ?? s.agentId)}: session-list HTTP 404; additional sessions unverified.\n`).join('') :
        'Session-list requests succeeded for every discovered bot.\n');
  }
  return document({ ...FIXED, document_type: 'export-manifest', account_id: m.account_id, archive_timezone: m.archive_timezone,
    coverage: coverageOf(m.certificate), completed_at: m.completed_at, certificate: m.certificate, inventory: m.inventory },
    `# Grok Bot export\n\n${m.inventory.length} conversations; ${count} text messages.\n\n${description}`);
}
interface Parsed { meta: Record<string, unknown>; body: Buffer }
function parse(bytes: Buffer): Parsed | null {
  const s = utf8(bytes); if (!s.startsWith('---\n')) return null;
  const end = s.indexOf('\n---\n', 4);
  const header = end < 0 ? s : s.slice(4, end + 1);
  const doc = parseDocument(header, { uniqueKeys: true, strict: true, schema: 'core' });
  let data: unknown;
  try { data = doc.toJS({ maxAliasCount: 0 }); } catch { data = null; }
  const claimed = data !== null && typeof data === 'object' && (data as Record<string, unknown>).generated_by === 'grok-vault';
  // Recover an explicit ownership marker from damaged YAML without claiming unrelated metadata.
  const malformed = end < 0 || doc.errors.length > 0 || doc.warnings.length > 0 || data === null;
  const damagedMarker = malformed && /^(?:generated_by|"generated_by"|'generated_by'):[ \t]*["']?grok-vault(?:["']|[ \t\r\n]|$)/m.test(header);
  if (!claimed && !damagedMarker) return null;
  requireThat(end >= 0 && doc.errors.length === 0 && doc.warnings.length === 0 && s.slice(end + 5, end + 6) === '\n', 'conflict', 'Malformed generated frontmatter; restore the original file or follow documented manual recovery.');
  const meta = record(data);
  requireThat(meta.source === FIXED.source && meta.generated_by === FIXED.generated_by && meta.format_version === 2, 'conflict', 'Unsupported generated archive format; a backed-up full-source migration is required.');
  requireThat(['complete-retained-history', 'observed-retained-history'].includes(String(meta.coverage)) && isHash(meta.render_hash), 'conflict', 'Invalid generated-file ownership or coverage metadata.');
  const hashLines = header.match(/^render_hash: "sha256:[0-9a-f]{64}"\n/gm);
  requireThat(hashLines?.length === 1, 'conflict', 'Missing or noncanonical generated-file hash.');
  const without = s.slice(0, 4) + header.replace(hashLines[0]!, '') + s.slice(end + 1);
  requireThat(hash(without) === meta.render_hash, 'conflict', 'A generated file was edited or corrupted. Restore its exact bytes or follow documented manual recovery.');
  return { meta, body: Buffer.from(s.slice(end + 6)) };
}
function participant(v: unknown): Speaker {
  const s = record(v); requireThat(s.kind === 'human' || s.kind === 'agent', 'conflict', 'Invalid participant metadata.');
  return { kind: s.kind, id: string(s.id) };
}
export function parseNote(bytes: Buffer): Note | null {
  const p = parse(bytes); if (!p) return null;
  const { meta: m, body } = p;
  requireThat(m.document_type === undefined, 'conflict', 'Completion manifest is not at its reserved root path.');
  const c: Conversation = { accountId: string(m.account_id), agentId: string(m.agent_id), sessionId: string(m.session_id, true), agentName: string(m.agent), sessionName: string(m.session, true) };
  const zone = timezone(m.archive_timezone);
  requireThat(m.date === null || typeof m.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(m.date), 'conflict', 'Invalid note date.');
  const messages = array(m.entry_index).map((value): Message => {
    const e = record(value); const offset = integer(e.content_offset), length = integer(e.content_bytes);
    requireThat(offset + length <= body.length, 'conflict', 'Content index is outside the note body.');
    const content = utf8(body.subarray(offset, offset + length));
    requireThat(isHash(e.content_hash) && hash(content) === e.content_hash, 'conflict', 'Content hash mismatch.');
    requireThat(e.role === 'user' || e.role === 'assistant', 'conflict', 'Invalid indexed role.');
    requireThat(e.source_kind === 'message' || e.source_kind === 'send-message', 'conflict', 'Invalid indexed source kind.');
    requireThat(e.source_role === null || e.source_role === 'user' || e.source_role === 'assistant', 'conflict', 'Invalid indexed source role.');
    let peer: Peer | null = null;
    if (e.peer !== null) { const v = record(e.peer); requireThat(v.direction === 'from' || v.direction === 'to', 'conflict', 'Invalid indexed peer direction.'); peer = { direction: v.direction, id: string(v.id), name: string(v.name) }; }
    return { entryId: string(e.id), role: e.role, sourceKind: e.source_kind, sourceRole: e.source_role,
      speaker: participant(e.speaker), peer, content, timestamp: e.source_timestamp === null ? null : isoTimestamp(e.source_timestamp),
      sourceGeneration: integer(e.source_generation, 0xffffffff), sourceSequence: uint64(e.source_sequence), sourceUpdatedSequence: uint64(e.source_updated_sequence),
      sourceOrder: integer(e.archive_order), sourceSchemaVersion: 1, contentHash: e.content_hash };
  });
  const note: Note = { conversation: c, timezone: zone, date: m.date as string | null, messages,
    ...(m.coverage === 'observed-retained-history' ? { coverage: 'observed-retained-history' as const } : {}) };
  requireThat(renderNote(note).equals(bytes), 'conflict', 'Generated note structure or metadata is noncanonical.'); return note;
}
export function certificate(value: unknown): Certificate {
  const c = record(value);
  if (c.consistency === 'matching-full-account-scans') {
    requireThat(c.contract === 'grok-bot-0.44.0/repeated-account-read-v1' && c.inventoryComplete === false && c.retentionBoundaryVerified === false && c.fullScanCount === 2 && isHash(c.boundary), 'coverage', 'Invalid repeated-read evidence.');
    let previous: string | undefined;
    const sessionCoverage = array(c.sessionCoverage).map((value): ObservedCertificate['sessionCoverage'][number] => {
      const s = record(value), agentId = string(s.agentId);
      requireThat(previous === undefined || compare(previous, agentId) < 0, 'coverage', 'Duplicate or unsorted session-coverage bots.'); previous = agentId;
      requireThat(s.scope === 'listed' || s.scope === 'default-only-unverified', 'coverage', 'Invalid session-coverage scope.');
      const sessionIds = array(s.sessionIds).map(v => string(v, true));
      requireThat(sessionIds[0] === '' && sessionIds.every((v, i) => i === 0 || compare(sessionIds[i - 1]!, v) < 0) && (s.scope !== 'default-only-unverified' || sessionIds.length === 1), 'coverage', 'Invalid session-coverage inventory.');
      return { agentId, scope: s.scope, sessionIds };
    });
    return { contract: c.contract, consistency: c.consistency, boundary: c.boundary, inventoryComplete: false,
      retentionBoundaryVerified: false, fullScanCount: 2, sessionCoverage };
  }
  requireThat(c.inventoryComplete === true && c.retentionBoundaryVerified === true && ['immutable-snapshot', 'validated-change-boundary', 'validated-quiescent-read'].includes(string(c.consistency)), 'coverage', 'Source completeness or snapshot consistency has not been verified.');
  return { contract: string(c.contract), consistency: c.consistency as VerifiedCertificate['consistency'], boundary: string(c.boundary), inventoryComplete: true, retentionBoundaryVerified: true };
}
export function validateSessionCoverage(c: Certificate, inventory: Pick<Inventory, 'agent_id' | 'session_id'>[]) {
  if (c.consistency !== 'matching-full-account-scans') return;
  const actual = new Map<string, string[]>();
  for (const i of inventory) { const ids = actual.get(i.agent_id) ?? []; ids.push(i.session_id); actual.set(i.agent_id, ids); }
  const expected = c.sessionCoverage.map(s => [s.agentId, s.sessionIds]);
  const found = [...actual].sort(([a], [b]) => compare(a, b)).map(([id, ids]) => [id, ids.sort(compare)]);
  requireThat(stable(expected) === stable(found), 'coverage', 'Session coverage disagrees with the exported conversation inventory.');
}
export function parseManifest(bytes: Buffer): Manifest {
  const parsed = parse(bytes); requireThat(parsed, 'conflict', 'An unrelated file occupies the completion-manifest path.');
  const m = parsed.meta;
  requireThat(m.document_type === 'export-manifest', 'conflict', 'Invalid completion manifest.');
  const account = string(m.account_id);
  const inventory = array(m.inventory).map((value): Inventory => {
    const v = record(value), sid = string(v.session_id, true), directory = conversationDirectory(string(v.directory), sid);
    requireThat(v.account_id === account && v.termination === 'empty-raw-page', 'conflict', 'Invalid inventory account or termination evidence.');
    const exclusions = record(v.exclusions); for (const n of Object.values(exclusions)) integer(n);
    const raw = integer(v.raw_count), exported = integer(v.exported_count);
    requireThat(isHash(v.raw_fingerprint), 'conflict', 'Invalid raw-history fingerprint.');
    requireThat(raw === exported + Object.values(exclusions).reduce<number>((n, x) => n + integer(x), 0), 'conflict', 'Manifest counts disagree.');
    if (raw === 0) requireThat(v.oldest_sequence === null && v.newest_sequence === null && v.max_updated_sequence === null, 'conflict', 'Empty history has nonempty boundaries.');
    else requireThat(v.oldest_sequence !== null && v.newest_sequence !== null && v.max_updated_sequence !== null && BigInt(uint64(v.oldest_sequence)) <= BigInt(uint64(v.newest_sequence)), 'conflict', 'Invalid retained-history boundaries.');
    return { account_id: account, agent_id: string(v.agent_id), agent: string(v.agent), session_id: sid, session: string(v.session, true), directory,
      raw_count: raw, exported_count: exported, exclusions: exclusions as Record<string, number>, generation: integer(v.generation, 0xffffffff), raw_fingerprint: v.raw_fingerprint,
      oldest_sequence: v.oldest_sequence === null ? null : uint64(v.oldest_sequence), newest_sequence: v.newest_sequence === null ? null : uint64(v.newest_sequence),
      max_updated_sequence: v.max_updated_sequence === null ? null : uint64(v.max_updated_sequence), termination: 'empty-raw-page' };
  });
  const result = { account_id: account, archive_timezone: timezone(m.archive_timezone), completed_at: isoTimestamp(m.completed_at), certificate: certificate(m.certificate), inventory };
  validateSessionCoverage(result.certificate, inventory);
  requireThat(renderManifest(result).equals(bytes), 'conflict', 'Completion manifest structure is noncanonical.'); return result;
}
