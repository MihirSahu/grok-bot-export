import { accessSync, constants, mkdirSync, readdirSync, renameSync, rmdirSync, unlinkSync, lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { requireThat } from '../diagnostics/errors';
import { array, compare, hash, isHash, json, record, stable, string } from '../validate';
import { parseManifest, parseNote } from '../render/markdown';
import { type Plan, validateArchive } from './archive';
import { collisionKey, relativePath, reserved } from './names';
import { checkedPath, durableFile, exists, noReplace, regularBytes, scanTree, syncDirectory } from './filesystem';

const JOURNAL = '.grok-vault-transaction';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
interface Target { path: string; old: string | null; next: string; payload: string }
interface Journal { generated_by: 'grok-vault'; version: 1; uuid: string; root: string; targets: Target[]; unchanged: { path: string; hash: string }[]; directories: string[] }
export type FaultHook = (point: string) => void;
const noFault: FaultHook = () => {};
function notePath(value: unknown): string {
  const path = relativePath(value), parts = path.split('/');
  requireThat(path === '_export.md' || !parts.some(reserved) && /^(_undated|\d{4}-\d{2}-\d{2})\.md$/.test(parts.at(-1)!) && (parts.length === 2 || parts.length === 4 && parts[1] === 'Sessions'), 'conflict', 'Invalid transaction target path.'); return path;
}
function journalBytes(j: Journal): Buffer { return Buffer.from(JSON.stringify({ ...j, checksum: hash(stable(j)) }) + '\n'); }
function readJournal(root: string, dir: string): Journal {
  requireThat(lstatSync(dir).isDirectory() && !lstatSync(dir).isSymbolicLink(), 'conflict', 'The transaction path is not a regular directory.');
  const data = record(json(regularBytes(join(dir, 'manifest.json'))));
  const { checksum, ...fields } = data;
  requireThat(isHash(checksum) && hash(stable(fields)) === checksum && data.generated_by === 'grok-vault' && data.version === 1 && data.root === root && UUID.test(string(data.uuid)), 'conflict', 'Invalid recovery journal. Preserve it for manual recovery.');
  const paths = new Set<string>();
  const unique = (path: string) => { const k = collisionKey(path); requireThat(!paths.has(k), 'conflict', 'Duplicate recovery target.'); paths.add(k); return path; };
  const targets = array(data.targets).map((value, index): Target => {
    const t = record(value); requireThat((t.old === null || isHash(t.old)) && isHash(t.next) && t.payload === `${index}.payload`, 'conflict', 'Invalid transaction hashes or payload path.');
    return { path: unique(notePath(t.path)), old: t.old as string | null, next: t.next, payload: t.payload as string };
  });
  requireThat(targets.length > 0 && targets.filter(t => t.path === '_export.md').every(t => t === targets.at(-1)), 'conflict', 'The completion manifest must publish last.');
  const unchanged = array(data.unchanged).map(value => { const v = record(value); requireThat(isHash(v.hash), 'conflict', 'Invalid unchanged-file hash.'); return { path: unique(notePath(v.path)), hash: v.hash }; });
  const directories = array(data.directories).map(value => {
    const path = relativePath(value), p = path.split('/');
    requireThat(!p.some(reserved) && (p.length === 1 || p.length <= 3 && p[1] === 'Sessions'), 'conflict', 'Invalid recovery directory.'); return path;
  });
  requireThat(new Set(directories.map(collisionKey)).size === directories.length, 'conflict', 'Duplicate recovery directory.');
  const result: Journal = { generated_by: 'grok-vault', version: 1, uuid: string(data.uuid), root, targets, unchanged, directories };
  requireThat(stable(result) === stable(fields), 'conflict', 'Unexpected journal fields.');
  return result;
}
function validateOld(path: string, data: Buffer) {
  if (path === '_export.md') parseManifest(data); else requireThat(parseNote(data), 'conflict', 'An unmarked file occupies a transaction target.');
}
function validateReplay(root: string, j: Journal, dir: string): void {
  const expectedNames = new Set(['manifest.json', ...j.targets.map(t => t.payload)]);
  requireThat(readdirSync(dir).every(n => expectedNames.has(n)) && readdirSync(dir).length === expectedNames.size, 'conflict', 'Recovery staging contains unexpected or missing files.');
  const tree = scanTree(root), planned = new Map<string, Buffer>(), expected = new Set([...j.targets.map(t => t.path), ...j.unchanged.map(t => t.path)]);
  const writeDirectories = new Set([root, dir]); // Journal completion and cleanup also need write/search access.
  const actualKeys = new Map([...tree.paths.keys()].map(p => [collisionKey(p), p]));
  for (const p of [...expected, ...j.directories]) requireThat(!actualKeys.has(collisionKey(p)) || actualKeys.get(collisionKey(p)) === p, 'conflict', 'A planned path collides with an existing normalized or case-folded path.');
  for (const [path, data] of tree.files) {
    if (expected.has(path)) continue;
    requireThat(path !== '_export.md' && parseNote(data) === null, 'conflict', 'Unexpected managed note added during publication.');
  }
  for (const item of j.unchanged) {
    const path = checkedPath(root, item.path, false), bytes = regularBytes(path);
    requireThat(hash(bytes) === item.hash, 'conflict', 'An unchanged managed file changed or disappeared during publication.');
    planned.set(item.path, bytes);
  }
  for (const t of j.targets) {
    const bytes = regularBytes(join(dir, t.payload)); requireThat(hash(bytes) === t.next, 'conflict', 'Staged payload hash mismatch.');
    const target = checkedPath(root, t.path);
    if (exists(target)) {
      const old = regularBytes(target), digest = hash(old);
      requireThat(digest === t.old || digest === t.next, 'conflict', 'A recovery target differs from both expected states. Preserve the journal and restore exact expected bytes.');
      validateOld(t.path, old);
      if (digest !== t.next) writeDirectories.add(dirname(target));
    } else {
      requireThat(t.old === null, 'conflict', 'An existing transaction target disappeared.');
      writeDirectories.add(dirname(target));
    }
    planned.set(t.path, bytes);
  }
  validateArchive(planned);
  // Planned directories must be exactly those implied by the final manifest, including empty sessions.
  const manifest = parseManifest(planned.get('_export.md')!);
  const required = new Set<string>();
  for (const i of manifest.inventory) { const parts = i.directory.split('/'); for (let n = 1; n <= parts.length; n++) required.add(parts.slice(0, n).join('/')); }
  requireThat(stable([...required].sort()) === stable([...j.directories].sort()), 'conflict', 'Recovery directories disagree with the final inventory.');
  for (const rel of j.directories) {
    const p = checkedPath(root, rel);
    if (exists(p)) requireThat(lstatSync(p).isDirectory(), 'conflict', 'A file occupies a recovery directory.');
    else writeDirectories.add(dirname(p));
  }
  const checkedDirectories = new Set<string>();
  for (let p of writeDirectories) {
    // Missing descendants will be created with mode 0700; check their nearest existing ancestor.
    while (p !== root && !exists(p)) p = dirname(p);
    if (checkedDirectories.has(p)) continue;
    try { accessSync(p, constants.W_OK | constants.X_OK); }
    catch { requireThat(false, 'filesystem', 'A destination directory lacks write or search permission. Restore its permissions and retry.'); }
    checkedDirectories.add(p);
  }
}
function cleanup(root: string, dir: string, j: Journal, hook: FaultHook) {
  const allowed = new Set(['manifest.json', ...j.targets.map(t => t.payload)]);
  requireThat(readdirSync(dir).every(n => allowed.has(n)), 'conflict', 'Unknown cleanup contents preserved.');
  for (const t of j.targets) {
    const path = join(dir, t.payload); if (!exists(path)) continue;
    requireThat(hash(regularBytes(path)) === t.next, 'conflict', 'Modified cleanup payload preserved.');
  }
  for (const t of j.targets) { const p = join(dir, t.payload); if (exists(p)) { unlinkSync(p); hook('cleanup-payload'); } }
  syncDirectory(dir); unlinkSync(join(dir, 'manifest.json')); syncDirectory(dir); hook('cleanup-manifest'); rmdirSync(dir); syncDirectory(root);
}
function replay(root: string, dir: string, j: Journal, hook: FaultHook): number {
  validateReplay(root, j, dir); hook('recovery-validated'); let published = 0;
  for (const rel of [...j.directories].sort((a, b) => a.split('/').length - b.split('/').length || compare(a, b))) {
    const p = checkedPath(root, rel);
    if (!exists(p)) { mkdirSync(p, { mode: 0o700 }); syncDirectory(p); syncDirectory(dirname(p)); hook('directory-created'); }
  }
  for (const t of j.targets) {
    const target = checkedPath(root, t.path);
    const current = exists(target) ? hash(regularBytes(target)) : null;
    if (current === t.next) continue;
    requireThat(current === t.old, 'conflict', 'A target changed during publication. Recovery data was retained.');
    const temp = join(dirname(target), `.grok-vault-note-${randomUUID()}.tmp`);
    const payload = regularBytes(join(dir, t.payload));
    requireThat(hash(payload) === t.next, 'conflict', 'A staged payload changed during publication.');
    durableFile(temp, payload); hook('note-staged');
    const check = exists(target) ? hash(regularBytes(target)) : null;
    requireThat(check === t.old, 'conflict', 'A target changed before atomic replacement. Recovery data was retained.');
    if (t.old === null) noReplace(temp, target); else renameSync(temp, target);
    syncDirectory(dirname(target)); published++; hook('note-published');
  }
  // Revalidate the whole final archive before marking the journal completed.
  validateReplay(root, j, dir);
  for (const t of j.targets) requireThat(hash(regularBytes(checkedPath(root, t.path, false))) === t.next, 'conflict', 'Final publication hash mismatch.');
  syncDirectory(root); hook('before-completion');
  const done = join(root, `.grok-vault-done-${j.uuid}`);
  noReplace(dir, done); syncDirectory(root); hook('completed'); cleanup(root, done, j, hook);
  return published;
}
export function recover(root: string, hook: FaultHook = noFault): number {
  let published = 0;
  const pending = join(root, JOURNAL);
  if (exists(pending)) { const journal = readJournal(root, pending); published = replay(root, pending, journal, hook); }
  for (const name of readdirSync(root)) {
    const match = /^\.grok-vault-done-(.+)$/.exec(name); if (!match || !UUID.test(match[1]!)) continue;
    const dir = join(root, name);
    // Empty residue after the final unlink is inert; no unproven directory is removed.
    if (lstatSync(dir).isDirectory() && !lstatSync(dir).isSymbolicLink() && exists(join(dir, 'manifest.json'))) {
      const j = readJournal(root, dir); requireThat(j.uuid === match[1], 'conflict', 'Cleanup identity mismatch.'); cleanup(root, dir, j, hook);
    }
  }
  return published;
}
export function publish(root: string, plan: Plan, hook: FaultHook = noFault): number {
  const targets: Target[] = [], unchanged: Journal['unchanged'] = [];
  const paths = [...plan.intended.keys()].sort((a, b) => a === '_export.md' ? 1 : b === '_export.md' ? -1 : compare(a, b));
  for (const path of paths) {
    const bytes = plan.intended.get(path)!, old = plan.old.get(path), next = hash(bytes);
    if (old?.equals(bytes)) unchanged.push({ path, hash: next });
    else targets.push({ path, old: old ? hash(old) : null, next, payload: `${targets.length}.payload` });
  }
  if (!targets.length) {
    const tree = scanTree(root), current = validateArchive(tree.files);
    requireThat(plan.directories.every(p => tree.paths.get(p) === 'directory'), 'conflict', 'An expected archive directory is missing or occupied by a file.');
    requireThat(current.managed.size === plan.old.size && [...plan.old].every(([p, b]) => current.managed.get(p)?.equals(b)), 'conflict', 'Archive changed during preflight.'); return 0;
  }
  const uuid = randomUUID(), stage = join(root, `.grok-vault-stage-${uuid}`);
  mkdirSync(stage, { mode: 0o700 }); hook('stage-created');
  const j: Journal = { generated_by: 'grok-vault', version: 1, uuid, root, targets, unchanged, directories: plan.directories };
  for (const t of targets) { durableFile(join(stage, t.payload), plan.intended.get(t.path)!); hook('payload-staged'); }
  durableFile(join(stage, 'manifest.json'), journalBytes(j)); syncDirectory(stage); hook('stage-durable');
  // Staging is now the durable byte source; do not retain a second rendered archive.
  plan.intended.clear(); plan.old.clear();
  validateReplay(root, j, stage); hook('preflight-validated');
  noReplace(stage, join(root, JOURNAL)); syncDirectory(root); hook('committed');
  return replay(root, join(root, JOURNAL), j, hook);
}
