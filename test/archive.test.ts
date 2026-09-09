import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Snapshot } from '../src/model';
import { allocateName, collisionKey, reserved } from '../src/export/names';
import { canonicalRoot, checkedPath, lockArchive, noReplace, regularBytes, scanTree } from '../src/export/filesystem';
import { planArchive, validateArchive } from '../src/export/archive';
import { publish, recover, type FaultHook } from '../src/export/transaction';
import { exportVault } from '../src/export/run';
import { dateParts, parseNote, renderNote } from '../src/render/markdown';
import { agent, c, history, message, signal, snapshot, source, workspace } from './fixtures';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const fn of cleanups.splice(0)) fn(); });
function ws() { const w = workspace(); cleanups.push(w.dispose); return w; }
function write(root: string, value = snapshot(), hook?: FaultHook) {
  const unlock = lockArchive(root);
  try { const plan = planArchive(scanTree(root), value, 'America/Chicago', '2026-09-08T00:00:00.000Z'); publish(root, plan, hook); return plan; }
  finally { unlock(); }
}
const all = (root: string) => validateArchive(scanTree(root).files);
function crashAt(point: string, occurrence = 1): FaultHook { let n = 0; return p => { if (p === point && ++n === occurrence) throw new Error('synthetic interruption'); }; }

describe('names and exact Markdown', () => {
  test('Unicode folding, reserved names, byte limits, and file collisions', () => {
    expect(collisionKey('Straße')).toBe(collisionKey('STRASSE'));
    expect(collisionKey('É')).toBe(collisionKey('e\u0301'));
    expect(collisionKey('Σ')).toBe(collisionKey('ς'));
    const occupied = new Set<string>([collisionKey('Taken')]);
    for (const input of ['_export.md', '_EXPORT.MD', '.grok-vault.lock', '.grok-vault-stage-example', '../bad', 'Taken', '👩🏽‍💻'.repeat(200)]) {
      const name = allocateName(input, input, occupied);
      expect(reserved(name)).toBe(false); expect(Buffer.byteLength(name)).toBeLessThanOrEqual(255); expect(name).not.toContain('/');
    }
  });
  test('preserves UTF-8 and CRLF even with fake metadata, footnotes and unclosed fences', () => {
    const content = 'é 👩🏽‍💻\r\n---\nrender_hash: fake\n---\n\n## 00:00 — You\n[x][ref]\n[^1]: note\n```js\n';
    const bytes = renderNote({ conversation: c, date: '2026-09-07', timezone: 'America/Chicago', messages: [message(0, { content }), message(1, { content: '' })] });
    const parsed = parseNote(bytes)!;
    expect(parsed.messages.map(m => m.content)).toEqual([content, '']); expect(renderNote(parsed)).toEqual(bytes);
    expect(() => parseNote(Buffer.from(bytes.toString().replace('é', 'e')))).toThrow('edited');
  });
  test('rejects frontmatter edits, duplicate keys, and noncanonical structure', () => {
    const bytes = renderNote({ conversation: c, date: '2026-09-07', timezone: 'UTC', messages: [message(0)] });
    expect(() => parseNote(Buffer.from(bytes.toString().replace('Researcher', 'Impostor')))).toThrow();
    expect(() => parseNote(Buffer.from(bytes.toString().replace('format_version: 2', 'format_version: 2\nformat_version: 2')))).toThrow();
    expect(() => parseNote(Buffer.from(bytes.toString().replace('content_offset":18', 'content_offset":0')))).toThrow();
  });
  test('malformed ownership metadata cannot hide a generated note', () => {
    const bytes = renderNote({ conversation: c, date: '2026-09-07', timezone: 'UTC', messages: [message(0)] }).toString();
    for (const marker of ['generated_by: "grok-vault', 'generated_by: "grok-vault"\ngenerated_by: "another-tool"']) {
      expect(() => parseNote(Buffer.from(bytes.replace('generated_by: "grok-vault"', marker)))).toThrow();
    }
  });
  test('DST folds use source order while both messages show the same local time', () => {
    expect(dateParts('2026-11-01T06:30:00.000Z', 'America/Chicago').time).toBe('01:30');
    expect(dateParts('2026-11-01T07:30:00.000Z', 'America/Chicago').time).toBe('01:30');
  });
});

describe('archive and reconciliation', () => {
  test('exports thousands of messages once and preserves no-op bytes and mtimes', () => {
    const { root } = ws(), value = snapshot([history(Array.from({ length: 1500 }, (_, i) => message(i)))]);
    expect(write(root, value).created).toBe(1);
    const before = all(root), times = new Map([...before.managed].map(([p]) => [p, statSync(join(root, p), { bigint: true }).mtimeNs]));
    expect(before.manifest!.inventory[0]!.exported_count).toBe(1500);
    const again = structuredClone(value); again.certificate.boundary = 'another-observation';
    expect(write(root, again).unchanged).toBe(1);
    for (const [p, bytes] of before.managed) { expect(readFileSync(join(root, p)).equals(bytes)).toBe(true); expect(statSync(join(root, p), { bigint: true }).mtimeNs).toBe(times.get(p)!); }
  });
  test('appends new messages and reuses directories across bot renames', () => {
    const { root } = ws(); write(root);
    const updated = snapshot([history([message(0), message(1)], { ...c, agentName: 'Renamed' })], [{ ...agent, name: 'Renamed' }]);
    expect(write(root, updated).updated).toBe(1);
    const archive = all(root); expect([...archive.notes.keys()]).toEqual(['Researcher/2026-09-07.md']);
    expect([...archive.notes.values()][0]!.conversation.agentName).toBe('Renamed'); expect(archive.manifest!.inventory[0]!.exported_count).toBe(2);
  });
  test('same IDs in different sessions remain separate, including empty conversations', () => {
    const { root } = ws(); const other = { ...c, sessionId: 'session-2', sessionName: 'Slack / α' };
    const empty = { ...c, sessionId: 'session-empty', sessionName: 'Empty' };
    write(root, snapshot([history(), history([message(0, { content: 'A separate session' })], other), history([], empty)]));
    const archive = all(root); expect(archive.manifest!.inventory).toHaveLength(3); expect(archive.notes.size).toBe(2);
    for (const i of archive.manifest!.inventory) expect(statSync(join(root, i.directory)).isDirectory()).toBe(true);
  });
  test('reserved agent names and unrelated preferred paths allocate distinct directories', () => {
    const { root } = ws(); writeFileSync(join(root, 'Researcher'), 'unrelated file');
    write(root); expect(readFileSync(join(root, 'Researcher'), 'utf8')).toBe('unrelated file');
    expect(all(root).manifest!.inventory[0]!.directory).toStartWith('Researcher — ');
    const w = ws(); write(w.root, snapshot([history([], { ...c, agentName: '_EXPORT.MD' })], [{ ...agent, name: '_EXPORT.MD' }]));
    expect(all(w.root).manifest!.inventory[0]!.directory).toStartWith('Agent — _EXPORT.MD');
  });
  test('bot and session names with backslashes export to stable safe directories', () => {
    const { root } = ws(), name = 'Windows\\Tools', renamed = { ...c, agentName: name };
    const value = snapshot([history([message(0)], renamed), history([message(0)], { ...renamed, sessionId: 'other', sessionName: 'Logs\\Daily' })], [{ ...agent, name }]);
    expect(write(root, value).created).toBe(2);
    const archive = all(root);
    expect(archive.manifest!.inventory[0]!.directory).toBe('Windows_Tools');
    expect(archive.manifest!.inventory[1]!.directory).toStartWith('Windows_Tools/Sessions/Logs_Daily — ');
    for (const note of archive.notes.values()) expect(note.conversation.agentName).toBe(name);
    expect(write(root, value).unchanged).toBe(2);
  });
  test('an empty roster preserves account identity and the first timezone', () => {
    const { root } = ws(); write(root, snapshot([], [])); const manifest = all(root).manifest!;
    expect(manifest.account_id).toBe(c.accountId); expect(manifest.inventory).toEqual([]); expect(manifest.archive_timezone).toBe('America/Chicago');
    const plan = planArchive(scanTree(root), snapshot([], []), 'Asia/Tokyo'); publish(root, plan);
    expect(all(root).manifest!.archive_timezone).toBe('America/Chicago');
  });
  for (const nondefault of [false, true]) for (const replacement of ['missing', 'file']) test(`no-op rejects ${replacement} empty ${nondefault ? 'session' : 'bot'} directory`, () => {
    const { root } = ws(), empty = { ...c, sessionId: nondefault ? 'empty' : '', sessionName: nondefault ? 'Empty' : '' };
    const value = snapshot(nondefault ? [history(), history([], empty)] : [history([], empty)]);
    write(root, value);
    const archive = all(root), directory = archive.manifest!.inventory.find(i => i.session_id === empty.sessionId)!.directory;
    const path = join(root, directory); rmdirSync(path);
    if (replacement === 'file') writeFileSync(path, 'unrelated file');
    expect(() => write(root, value)).toThrow('directory');
    for (const [p, bytes] of archive.managed) expect(readFileSync(join(root, p)).equals(bytes)).toBe(true);
    if (replacement === 'file') expect(readFileSync(path, 'utf8')).toBe('unrelated file');
    expect(existsSync(join(root, '.grok-vault-transaction'))).toBe(false);
  });
  test('timezone changes do not move notes and absent timestamps migrate once', () => {
    const { root } = ws(); write(root, snapshot([history([message(0, { timestamp: null }), message(1)])]));
    const plan = planArchive(scanTree(root), snapshot([history([message(0, { sourceUpdatedSequence: '3' }), message(1)])]), 'Asia/Tokyo');
    publish(root, plan); const archive = all(root);
    expect(archive.notes.get('Researcher/_undated.md')!.messages).toEqual([]);
    expect(archive.notes.get('Researcher/2026-09-07.md')!.messages.map(m => m.entryId)).toEqual(['entry-0', 'entry-1']);
    expect(archive.manifest!.archive_timezone).toBe('America/Chicago');
  });
  for (const [name, modify] of [
    ['text rewrite', (s: Snapshot) => { s.histories[0]!.messages[0]!.content = 'rewrite'; }],
    ['missing old message', (s: Snapshot) => { s.histories[0] = history([]); }],
    ['generation reset', (s: Snapshot) => { s.histories[0]!.generation = 2; }],
    ['missing bot', (s: Snapshot) => { s.histories = []; s.agents = []; }],
    ['wrong account', (s: Snapshot) => { s.accountId = 'other'; }],
  ] as const) test(`preserves the archive on ${name}`, () => {
    const { root } = ws(); write(root); const before = readFileSync(join(root, '_export.md'));
    const changed = snapshot(); modify(changed); expect(() => write(root, changed)).toThrow();
    expect(readFileSync(join(root, '_export.md'))).toEqual(before);
  });
  for (const path of ['_export.md', 'Researcher/2026-09-07.md']) test(`manual edits to ${path} fail before publication`, () => {
    const { root } = ws(); write(root); const p = join(root, path); const changed = readFileSync(p, 'utf8') + '\nmanual change\n'; writeFileSync(p, changed);
    expect(() => write(root, snapshot([history([message(0), message(1)])]))).toThrow(); expect(readFileSync(p, 'utf8')).toBe(changed);
    expect(existsSync(join(root, '.grok-vault-transaction'))).toBe(false);
  });
  test('missing and renamed managed files cannot masquerade as a fresh archive', () => {
    const { root } = ws(); write(root); renameSync(join(root, 'Researcher/2026-09-07.md'), join(root, 'Researcher/renamed.txt'));
    expect(() => write(root)).toThrow('renamed');
    renameSync(join(root, 'Researcher/renamed.txt'), join(root, 'Researcher/2026-09-07.md'));
    unlinkSync(join(root, '_export.md')); expect(() => write(root)).toThrow('manifest');
  });
  test('unrelated notes and binary files remain unchanged', () => {
    const { root } = ws(); writeFileSync(join(root, 'personal.md'), 'my own notes'); writeFileSync(join(root, 'photo.bin'), Buffer.from([0xff, 0x00, 0x80]));
    write(root); expect(readFileSync(join(root, 'personal.md'), 'utf8')).toBe('my own notes'); expect(readFileSync(join(root, 'photo.bin'))).toEqual(Buffer.from([0xff, 0x00, 0x80]));
  });
  test('unrelated frontmatter mentioning grok-vault stays unowned across exports', () => {
    const { root } = ws();
    const headers = ['title: grok-vault', 'generated_by: another-tool\ntitle: grok-vault', 'tools:\n  generated_by: grok-vault', 'title: [grok-vault'];
    const notes = headers.map(header => Buffer.from(`---\n${header}\n---\n\nPersonal notes\n`));
    notes.forEach((bytes, i) => { expect(parseNote(bytes)).toBeNull(); writeFileSync(join(root, `personal-${i}.md`), bytes); });
    expect(write(root).created).toBe(1);
    expect(write(root).unchanged).toBe(1);
    notes.forEach((bytes, i) => expect(readFileSync(join(root, `personal-${i}.md`))).toEqual(bytes));
  });
});

describe('durable transactions and filesystem boundaries', () => {
  for (const session of [false, true]) test(`permissions preflight preserves both bots when a ${session ? 'session' : 'bot'} directory is unwritable`, () => {
    const { root } = ws(), other = { ...agent, id: 'other', name: 'Zulu' };
    const conversation = { ...c, agentId: other.id, agentName: other.name, sessionId: session ? 'extra' : '', sessionName: session ? 'Extra' : '' };
    const value = (count: number) => snapshot([
      history(Array.from({ length: count }, (_, i) => message(i))),
      ...(session ? [history([], { ...conversation, sessionId: '', sessionName: '' })] : []),
      history(Array.from({ length: count }, (_, i) => message(i)), conversation),
    ], [agent, other]);
    write(root, value(1));
    const before = all(root), directory = join(root, before.manifest!.inventory.find(i => i.agent_id === other.id && i.session_id === conversation.sessionId)!.directory);
    const times = new Map([...before.managed.keys()].map(p => [p, statSync(join(root, p), { bigint: true }).mtimeNs]));
    chmodSync(directory, 0o500);
    try {
      const events: string[] = [];
      expect(() => write(root, value(2), p => events.push(p))).toThrow('permission');
      expect(events).not.toContain('committed');
      expect(existsSync(join(root, '.grok-vault-transaction'))).toBe(false);
      for (const [p, bytes] of before.managed) {
        expect(readFileSync(join(root, p)).equals(bytes)).toBe(true);
        expect(statSync(join(root, p), { bigint: true }).mtimeNs).toBe(times.get(p)!);
      }
      expect(statSync(directory).mode & 0o777).toBe(0o500);
    } finally { chmodSync(directory, 0o700); }
    expect(write(root, value(2)).updated).toBe(2);
  });
  for (const existingSessions of [false, true]) test(`permissions preflight checks the existing ancestor when ${existingSessions ? 'the Sessions parent exists' : 'nested directories are missing'}`, () => {
    const { root } = ws(); write(root);
    const directory = join(root, 'Researcher', ...(existingSessions ? ['Sessions'] : []));
    if (existingSessions) mkdirSync(directory);
    const before = all(root);
    const value = snapshot([history([message(0), message(1)]), history([], { ...c, sessionId: 'empty', sessionName: 'Empty' })]);
    chmodSync(directory, 0o500);
    try {
      const events: string[] = [];
      expect(() => write(root, value, p => events.push(p))).toThrow('permission');
      expect(events).not.toContain('committed');
      expect(existsSync(join(root, '.grok-vault-transaction'))).toBe(false);
      for (const [p, bytes] of before.managed) expect(readFileSync(join(root, p)).equals(bytes)).toBe(true);
    } finally { chmodSync(directory, 0o700); }
    write(root, value); expect(all(root).manifest!.inventory).toHaveLength(2);
  });
  test('permissions preflight blocks recovery before any remaining target is published', () => {
    const { root } = ws(), other = { ...agent, id: 'other', name: 'Zulu' };
    const otherConversation = { ...c, agentId: other.id, agentName: other.name };
    const value = (count: number) => snapshot([history(Array.from({ length: count }, (_, i) => message(i))), history(Array.from({ length: count }, (_, i) => message(i)), otherConversation)], [agent, other]);
    write(root, value(1)); const before = all(root);
    expect(() => write(root, value(2), crashAt('committed'))).toThrow('synthetic');
    const directory = join(root, 'Zulu'), journalPath = join(root, '.grok-vault-transaction/manifest.json'), journal = readFileSync(journalPath);
    chmodSync(directory, 0o500);
    try {
      expect(() => recover(root)).toThrow('permission');
      for (const [p, bytes] of before.managed) expect(readFileSync(join(root, p)).equals(bytes)).toBe(true);
      expect(readFileSync(journalPath)).toEqual(journal);
    } finally { chmodSync(directory, 0o700); }
    recover(root); expect(all(root).manifest!.inventory.every(i => i.exported_count === 2)).toBe(true);
  });
  test('permissions preflight permits recovery when a read-only directory contains only completed targets', () => {
    const { root } = ws();
    expect(() => write(root, snapshot(), crashAt('note-published'))).toThrow('synthetic');
    const directory = join(root, 'Researcher'), path = join(directory, '2026-09-07.md'), bytes = readFileSync(path), time = statSync(path, { bigint: true }).mtimeNs;
    chmodSync(directory, 0o500);
    try {
      recover(root);
      expect(readFileSync(path)).toEqual(bytes); expect(statSync(path, { bigint: true }).mtimeNs).toBe(time);
      expect(all(root).manifest!.inventory[0]!.exported_count).toBe(1);
      expect(existsSync(join(root, '.grok-vault-transaction'))).toBe(false);
    } finally { chmodSync(directory, 0o700); }
  });
  test('permissions preflight checks journal cleanup access before recovery writes', () => {
    const { root } = ws();
    expect(() => write(root, snapshot(), crashAt('committed'))).toThrow('synthetic');
    const directory = join(root, '.grok-vault-transaction'); chmodSync(directory, 0o500);
    try {
      expect(() => recover(root)).toThrow('permission');
      expect(existsSync(join(root, 'Researcher'))).toBe(false);
      expect(existsSync(join(directory, 'manifest.json'))).toBe(true);
    } finally { chmodSync(directory, 0o700); }
    recover(root); expect(all(root).notes.size).toBe(1);
  });
  test('permissions preflight permits unchanged directories and replacement of read-only files', () => {
    const { root } = ws(), other = { ...agent, id: 'other', name: 'Zulu' }, otherConversation = { ...c, agentId: other.id, agentName: other.name };
    const value = snapshot([history(), history([message(0)], otherConversation)], [agent, other]);
    write(root, value);
    const directory = join(root, 'Zulu'), target = join(root, 'Researcher/2026-09-07.md');
    chmodSync(directory, 0o500); chmodSync(target, 0o400);
    try {
      expect(write(root, value).unchanged).toBe(2);
      const updated = snapshot([history([message(0), message(1)]), history([message(0)], otherConversation)], [agent, other]);
      expect(write(root, updated).updated).toBe(1);
      expect(statSync(directory).mode & 0o777).toBe(0o500);
    } finally { chmodSync(directory, 0o700); }
  });
  for (const point of ['committed', 'note-published', 'completed']) test(`OS process death at ${point} releases the lock and preserves recoverable bytes`, async () => {
    const { root, vault } = ws();
    const child = Bun.spawn([process.execPath, 'test/helpers/crash-worker.ts', vault, point], { stdout: 'ignore', stderr: 'pipe' });
    expect(await child.exited).not.toBe(0);
    const unlock = lockArchive(root); try { recover(root); } finally { unlock(); }
    expect(all(root).notes.size).toBe(1); expect(all(root).manifest!.inventory[0]!.exported_count).toBe(1);
  });
  test('the OS lock excludes a separately running process', async () => {
    const { root, vault } = ws();
    const child = Bun.spawn([process.execPath, 'test/helpers/crash-worker.ts', vault, 'hold-lock'], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    try {
      const reader = child.stdout.getReader(); const value = await reader.read(); reader.releaseLock();
      expect(new TextDecoder().decode(value.value)).toContain('locked'); expect(() => lockArchive(root)).toThrow('Another');
    } finally { child.stdin.write('release\n'); child.stdin.end(); await child.exited; }
    const unlock = lockArchive(root); unlock();
  });
  test('native lock excludes another exporter and preserves its inode', () => {
    const { root } = ws(), unlock = lockArchive(root), inode = statSync(join(root, '.grok-vault.lock')).ino;
    expect(() => lockArchive(root)).toThrow('Another'); unlock(); const again = lockArchive(root); again();
    expect(statSync(join(root, '.grok-vault.lock')).ino).toBe(inode); expect(readFileSync(join(root, '.grok-vault.lock')).length).toBe(0);
  });
  test('native no-replace refuses an occupied path', () => {
    const { vault } = ws(); const a = join(vault, 'source'), b = join(vault, 'target'); writeFileSync(a, 'new'); writeFileSync(b, 'old');
    expect(() => noReplace(a, b)).toThrow('no-clobber'); expect(readFileSync(b, 'utf8')).toBe('old'); expect(readFileSync(a, 'utf8')).toBe('new');
  });
  for (const point of ['stage-created', 'payload-staged', 'stage-durable', 'preflight-validated']) test(`precommit fault at ${point} publishes no notes`, () => {
    const { root } = ws(); expect(() => write(root, snapshot(), crashAt(point))).toThrow('synthetic');
    expect(all(root).managed.size).toBe(0); expect(existsSync(join(root, '.grok-vault-transaction'))).toBe(false);
    expect(recover(root)).toBe(0); write(root); expect(all(root).notes.size).toBe(1);
  });
  for (const point of ['committed', 'recovery-validated', 'directory-created', 'note-staged', 'note-published', 'before-completion', 'completed', 'cleanup-payload', 'cleanup-manifest']) test(`recovers interruption at ${point} without reading the source`, () => {
    const { root } = ws(); expect(() => write(root, snapshot(), crashAt(point))).toThrow('synthetic');
    const unlock = lockArchive(root); try { recover(root); } finally { unlock(); }
    expect(all(root).manifest!.inventory[0]!.exported_count).toBe(1); expect(all(root).notes.size).toBe(1);
    expect(existsSync(join(root, '.grok-vault-transaction'))).toBe(false); expect(write(root).unchanged).toBe(1);
  });
  test('partially published timestamp migration recovers even when visible notes temporarily duplicate IDs', () => {
    const { root } = ws(); write(root, snapshot([history([message(0, { timestamp: null }), message(1)])]));
    const value = snapshot([history([message(0, { sourceUpdatedSequence: '3' }), message(1)])]);
    expect(() => write(root, value, crashAt('note-published'))).toThrow();
    expect(() => all(root)).toThrow(); recover(root);
    expect(all(root).notes.get('Researcher/_undated.md')!.messages.length).toBe(0); expect(all(root).notes.get('Researcher/2026-09-07.md')!.messages.length).toBe(2);
  });
  test('changed unchanged-file inventory prevents any replay', () => {
    const { root } = ws(); write(root);
    const value = snapshot([history([message(0), message(1, { timestamp: '2026-09-08T19:03:00.000Z' })])]);
    expect(() => write(root, value, crashAt('committed'))).toThrow();
    const original = join(root, 'Researcher/2026-09-07.md'), bytes = readFileSync(original); writeFileSync(original, Buffer.concat([bytes, Buffer.from('edited')]));
    expect(() => recover(root)).toThrow('unchanged'); expect(existsSync(join(root, 'Researcher/2026-09-08.md'))).toBe(false);
    writeFileSync(original, bytes); recover(root); expect(all(root).notes.size).toBe(2);
  });
  test('unmarked target race preserves both unrelated content and journal', () => {
    const { root } = ws(); expect(() => write(root, snapshot(), crashAt('committed'))).toThrow();
    mkdirSync(join(root, 'Researcher')); const target = join(root, 'Researcher/2026-09-07.md'); writeFileSync(target, 'unrelated');
    expect(() => recover(root)).toThrow('both expected states'); expect(readFileSync(target, 'utf8')).toBe('unrelated');
    expect(existsSync(join(root, '.grok-vault-transaction/manifest.json'))).toBe(true);
  });
  test('modified manifest cannot bypass a committed recovery journal', () => {
    const { root } = ws(); write(root);
    expect(() => write(root, snapshot([history([message(0), message(1)])]), crashAt('committed'))).toThrow();
    const manifest = join(root, '_export.md'), original = readFileSync(manifest); writeFileSync(manifest, Buffer.concat([original, Buffer.from('manual')]));
    expect(() => recover(root)).toThrow('both expected states'); writeFileSync(manifest, original); recover(root); expect(all(root).manifest!.inventory[0]!.exported_count).toBe(2);
  });
  test('journal paths, payloads and directory contents are validated before replay', () => {
    const { root } = ws(); expect(() => write(root, snapshot(), crashAt('committed'))).toThrow();
    const dir = join(root, '.grok-vault-transaction'); writeFileSync(join(dir, 'unexpected'), 'preserve me');
    expect(() => recover(root)).toThrow('unexpected'); expect(existsSync(join(root, '_export.md'))).toBe(false);
    unlinkSync(join(dir, 'unexpected')); writeFileSync(join(dir, '0.payload'), 'corrupt'); expect(() => recover(root)).toThrow('hash');
  });
  test('source failure after recovery is reported separately and closes credentials', async () => {
    const { root, vault } = ws(); expect(() => write(root, snapshot(), crashAt('committed'))).toThrow();
    let closed = false; const progress: string[] = [];
    await expect(exportVault(vault, { snapshot: async () => { throw new Error('offline'); }, close() { closed = true; } }, signal(), s => progress.push(s))).rejects.toThrow('offline');
    expect(closed).toBe(true); expect(progress[0]).toStartWith('Recovered'); expect(all(root).notes.size).toBe(1);
  });
  test('full pipeline publishes only a verified source snapshot', async () => {
    const { root, vault } = ws(); expect((await exportVault(vault, source(), signal())).messages).toBe(1);
    const invalid = snapshot(); invalid.certificate.inventoryComplete = false as true;
    const manifest = readFileSync(join(root, '_export.md'));
    await expect(exportVault(vault, source(invalid), signal())).rejects.toThrow('verified'); expect(readFileSync(join(root, '_export.md'))).toEqual(manifest);
  });
  test('symlinks, hard links, path escape and unsafe roots are refused', () => {
    const { root, vault } = ws(); expect(() => checkedPath(root, '../escape')).toThrow();
    const outside = join(vault, 'outside'); writeFileSync(outside, 'unrelated'); symlinkSync(outside, join(root, 'link'));
    expect(() => write(root)).toThrow('symlink'); unlinkSync(join(root, 'link'));
    linkSync(outside, join(root, 'hard')); expect(() => regularBytes(join(root, 'hard'))).toThrow('hard-linked');
    const fakeVault = join(vault, 'linked-vault'); symlinkSync(root, fakeVault); expect(() => canonicalRoot(fakeVault)).toThrow('symlink');
  });
  test('new files and directories use restrictive modes', () => {
    const { root } = ws(); write(root);
    expect(statSync(join(root, 'Researcher')).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, 'Researcher/2026-09-07.md')).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, '_export.md')).mode & 0o777).toBe(0o600);
  });
});
