import { basename, dirname } from 'node:path';
import type { Coverage, Snapshot } from '../model';
import { agentKey, conversationKey, coverageOf } from '../model';
import { compare, integer, stable, string, timezone } from '../validate';
import { requireThat } from '../diagnostics/errors';
import { certificate, dateParts, parseManifest, parseNote, renderManifest, renderNote, type Inventory, type Manifest, type Note } from '../render/markdown';
import { allocateName, collisionKey, conversationDirectory } from './names';
import type { Tree } from './filesystem';

export interface Archive { manifest: Manifest | null; notes: Map<string, Note>; managed: Map<string, Buffer>; conversations: Map<string, { directory: string; notes: Note[] }> }
const invConversation = (i: Inventory) => ({ accountId: i.account_id, agentId: i.agent_id, sessionId: i.session_id });
export function validateArchive(files: Map<string, Buffer>): Archive {
  const archive: Archive = { manifest: null, notes: new Map(), managed: new Map(), conversations: new Map() };
  const agents = new Map<string, string>(), directories = new Map<string, string>();
  for (const [path, bytes] of files) {
    if (path === '_export.md') { archive.manifest = parseManifest(bytes); archive.managed.set(path, bytes); continue; }
    const note = parseNote(bytes); if (!note) continue;
    const expected = note.date === null ? '_undated.md' : `${note.date}.md`;
    requireThat(basename(path) === expected, 'conflict', 'A generated note has been renamed or moved.');
    archive.notes.set(path, note); archive.managed.set(path, bytes);
  }
  requireThat(archive.notes.size === 0 || archive.manifest, 'conflict', 'Generated notes are missing their completion manifest. Restore it or follow documented manual recovery.');
  const manifest = archive.manifest;
  if (!manifest) return archive;
  const inventory = new Map<string, Inventory>(); let previous: string | undefined;
  for (const i of manifest.inventory) {
    const c = invConversation(i), key = conversationKey(c), ak = agentKey(c), directory = conversationDirectory(i.directory, i.session_id), top = directory.split('/')[0]!;
    requireThat(!inventory.has(key) && (previous === undefined || compare(previous, key) < 0), 'conflict', 'Duplicate or unsorted completion inventory.'); previous = key;
    requireThat(!agents.has(ak) || agents.get(ak) === top, 'conflict', 'One bot identity appears in multiple directories.'); agents.set(ak, top);
    const dk = collisionKey(directory);
    requireThat(!directories.has(dk) || directories.get(dk) === key, 'conflict', 'Conversation directories collide.'); directories.set(dk, key);
    inventory.set(key, i); archive.conversations.set(key, { directory, notes: [] });
  }
  for (const [path, note] of archive.notes) {
    const key = conversationKey(note.conversation), i = inventory.get(key);
    requireThat(i && dirname(path) === i.directory && note.timezone === manifest.archive_timezone && note.conversation.accountId === manifest.account_id && note.conversation.agentName === i.agent && note.conversation.sessionName === i.session, 'conflict', 'A generated note disagrees with its completion inventory.');
    requireThat((note.coverage ?? 'complete-retained-history') === coverageOf(manifest.certificate), 'conflict', 'A generated note disagrees with its manifest coverage.');
    archive.conversations.get(key)!.notes.push(note);
  }
  const topOwners = new Map<string, string>();
  for (const [ak, top] of agents) { const k = collisionKey(top); requireThat(!topOwners.has(k) || topOwners.get(k) === ak, 'conflict', 'A bot directory contains multiple bot identities.'); topOwners.set(k, ak); }
  for (const [key, c] of archive.conversations) {
    const entries = c.notes.flatMap(n => n.messages).sort((a, b) => a.sourceOrder - b.sourceOrder), i = inventory.get(key)!;
    requireThat(entries.length === i.exported_count, 'conflict', 'A conversation is missing archived messages.');
    const ids = new Set<string>(); let seq: bigint | null = null;
    entries.forEach((e, index) => {
      requireThat(e.sourceOrder === index && !ids.has(e.entryId) && e.sourceGeneration === i.generation && (seq === null || BigInt(e.sourceSequence) > seq), 'conflict', 'Archive order, source generation, or message identity is inconsistent.');
      ids.add(e.entryId); seq = BigInt(e.sourceSequence);
    });
  }
  return archive;
}
export interface Plan { old: Map<string, Buffer>; intended: Map<string, Buffer>; directories: string[]; created: number; updated: number; unchanged: number; messages: number; conversations: number; excluded: number; coverage: Coverage; unverifiedSessionInventories: number }
export function planArchive(tree: Tree, snapshot: Snapshot, capturedTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone, now = new Date().toISOString()): Plan {
  certificate(snapshot.certificate); string(snapshot.accountId);
  const archive = validateArchive(tree.files), previous = archive.manifest;
  requireThat(!previous || previous.account_id === snapshot.accountId, 'conflict', 'The signed-in account differs from the archive account.');
  const zone = timezone(previous?.archive_timezone ?? capturedTimezone);
  const agents = new Map(snapshot.agents.map(a => [a.id, a]));
  requireThat(agents.size === snapshot.agents.length, 'coverage', 'Duplicate snapshot bot IDs.');
  const histories = [...snapshot.histories].sort((a, b) => compare(conversationKey(a.conversation), conversationKey(b.conversation)));
  const keys = new Set<string>();
  for (const h of histories) {
    const c = h.conversation, key = conversationKey(c); string(c.agentId); string(c.sessionId, true); string(c.agentName); string(c.sessionName, true);
    requireThat(!keys.has(key) && c.accountId === snapshot.accountId && agents.get(c.agentId)?.name === c.agentName, 'coverage', 'Invalid or duplicate snapshot conversation.'); keys.add(key);
    requireThat(h.rawCount === h.messages.length + Object.values(h.exclusions).reduce((a, b) => a + integer(b), 0) && h.termination === 'empty-raw-page', 'coverage', 'Snapshot row accounting or history boundary is incomplete.');
  }
  for (const a of agents.values()) requireThat(keys.has(conversationKey({ accountId: snapshot.accountId, agentId: a.id, sessionId: '' })), 'coverage', 'A bot is missing its default-session route.');
  for (const i of previous?.inventory ?? []) requireThat(keys.has(conversationKey(invConversation(i))), 'conflict', 'An archived bot or session is missing from the new source snapshot.');
  const occupiedRoot = new Set([...tree.paths.keys()].filter(p => !p.includes('/')).map(collisionKey));
  occupiedRoot.add(collisionKey('_export.md'));
  const agentDirs = new Map<string, string>(), dirs = new Set<string>();
  for (const i of previous?.inventory ?? []) agentDirs.set(i.agent_id, i.directory.split('/')[0]!);
  for (const a of [...agents.values()].sort((a, b) => compare(a.id, b.id))) {
    if (!agentDirs.has(a.id)) agentDirs.set(a.id, allocateName(a.name, agentKey({ accountId: snapshot.accountId, agentId: a.id }), occupiedRoot));
    dirs.add(agentDirs.get(a.id)!);
  }
  const intended = new Map<string, Buffer>(), inventory: Inventory[] = [];
  for (const h of histories) {
    const c = h.conversation, key = conversationKey(c), old = archive.conversations.get(key);
    const oldInventory = previous?.inventory.find(i => conversationKey(invConversation(i)) === key);
    if (oldInventory) requireThat(h.generation === oldInventory.generation && h.rawCount >= oldInventory.raw_count, 'conflict', 'Source history was cleared, truncated, or rewritten. Preserve the archive and review the source.');
    const newById = new Map(h.messages.map(m => [m.entryId, m]));
    requireThat(newById.size === h.messages.length, 'coverage', 'Duplicate source message IDs.');
    for (const m of old?.notes.flatMap(n => n.messages) ?? []) {
      const n = newById.get(m.entryId);
      requireThat(n && n.content === m.content && n.role === m.role && n.sourceKind === m.sourceKind && n.sourceRole === m.sourceRole && stable(n.speaker) === stable(m.speaker) &&
        stable(n.peer && [n.peer.direction, n.peer.id]) === stable(m.peer && [m.peer.direction, m.peer.id]) && (m.timestamp === null || n.timestamp === m.timestamp) &&
        n.sourceOrder === m.sourceOrder && n.sourceSequence === m.sourceSequence && n.sourceGeneration === m.sourceGeneration && BigInt(n.sourceUpdatedSequence) >= BigInt(m.sourceUpdatedSequence),
        'conflict', 'Previously archived history is missing or changed. Existing notes were preserved.');
    }
    let directory = old?.directory ?? agentDirs.get(c.agentId)!;
    if (!old && c.sessionId !== '') {
      const parent = `${directory}/Sessions`;
      requireThat(tree.paths.get(parent) !== 'file', 'conflict', 'A file occupies the reserved Sessions directory.');
      const occupied = new Set([...tree.paths.keys(), ...dirs].filter(p => dirname(p) === parent).map(p => collisionKey(basename(p))));
      directory = `${parent}/${allocateName(c.sessionName || 'Session', key, occupied, true)}`;
    }
    conversationDirectory(directory, c.sessionId); dirs.add(directory);
    if (c.sessionId !== '') dirs.add(`${agentDirs.get(c.agentId)!}/Sessions`);
    const byDate = new Map<string | null, typeof h.messages>();
    for (const m of h.messages) { const date = dateParts(m.timestamp, zone).date; const list = byDate.get(date) ?? []; list.push(m); byDate.set(date, list); }
    if (old?.notes.some(n => n.date === null) && !byDate.has(null)) byDate.set(null, []);
    for (const [date, messages] of byDate) {
      const path = `${directory}/${date === null ? '_undated' : date}.md`;
      requireThat(!tree.paths.has(path) || archive.managed.has(path), 'conflict', 'An unrelated file occupies a planned note path.');
      intended.set(path, renderNote({ conversation: c, timezone: zone, date, messages, coverage: coverageOf(snapshot.certificate) }));
    }
    inventory.push({ account_id: c.accountId, agent_id: c.agentId, agent: c.agentName, session_id: c.sessionId, session: c.sessionName, directory,
      raw_count: h.rawCount, exported_count: h.messages.length, exclusions: h.exclusions, generation: h.generation, raw_fingerprint: h.rawFingerprint,
      oldest_sequence: h.oldestSequence, newest_sequence: h.newestSequence, max_updated_sequence: h.maxUpdatedSequence, termination: h.termination });
  }
  const manifest: Manifest = { account_id: snapshot.accountId, archive_timezone: zone, completed_at: now, certificate: snapshot.certificate, inventory };
  // Completion time and the observational boundary alone do not rewrite an unchanged archive.
  if (previous && [...intended].every(([p, b]) => archive.managed.get(p)?.equals(b)) && stable({ ...previous, completed_at: '', certificate: { ...previous.certificate, boundary: '' } }) === stable({ ...manifest, completed_at: '', certificate: { ...manifest.certificate, boundary: '' } })) {
    manifest.completed_at = previous.completed_at; manifest.certificate = previous.certificate;
  }
  intended.set('_export.md', renderManifest(manifest));
  for (const path of archive.managed.keys()) requireThat(intended.has(path), 'conflict', 'Reconciliation would remove an archived note.');
  validateArchive(intended);
  let created = 0, updated = 0, unchanged = 0;
  for (const [p, bytes] of intended) {
    if (p === '_export.md') continue;
    const before = archive.managed.get(p); if (!before) created++; else if (before.equals(bytes)) unchanged++; else updated++;
  }
  return { old: archive.managed, intended, directories: [...dirs].sort((a, b) => a.split('/').length - b.split('/').length || compare(a, b)), created, updated, unchanged,
    messages: histories.reduce((n, h) => n + h.messages.length, 0), conversations: histories.length, excluded: histories.reduce((n, h) => n + h.rawCount - h.messages.length, 0),
    coverage: coverageOf(snapshot.certificate), unverifiedSessionInventories: snapshot.certificate.consistency === 'matching-full-account-scans' ? snapshot.certificate.sessionCoverage.filter(s => s.scope === 'default-only-unverified').length : 0 };
}
