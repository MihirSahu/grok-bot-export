import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { dlopen, FFIType, ptr } from 'bun:ffi';
import { requireThat } from '../diagnostics/errors';
import { collisionKey, relativePath, reserved } from './names';

let libc: ReturnType<typeof native> | undefined;
function native() {
  requireThat(process.platform === 'darwin' && process.arch === 'arm64', 'platform', 'This build requires an Apple Silicon Mac.');
  return dlopen('/usr/lib/libSystem.B.dylib', {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    renamex_np: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  });
}
export function noReplace(from: string, to: string) {
  libc ??= native(); const a = Buffer.from(from + '\0'), b = Buffer.from(to + '\0');
  requireThat(libc.symbols.renamex_np(ptr(a), ptr(b), 4) === 0, 'conflict', 'Atomic no-clobber publication failed; the destination may already be occupied.');
}
export function syncDirectory(path: string) { const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { fsyncSync(fd); } finally { closeSync(fd); } }
export function durableFile(path: string, data: Uint8Array) {
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
}
export function regularBytes(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    requireThat(before.isFile() && before.nlink === 1n, 'conflict', 'A managed file is nonregular or hard-linked.');
    const data = readFileSync(fd), after = fstatSync(fd, { bigint: true });
    requireThat(before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs, 'conflict', 'A file changed during validation.');
    return data;
  } finally { closeSync(fd); }
}
export function exists(path: string) { try { lstatSync(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; } }
export function within(parent: string, child: string) { return child === parent || child.startsWith(parent + sep); }
export function canonicalRoot(vaultPath: string): string {
  requireThat(!vaultPath.includes('\0'), 'usage', 'Invalid vault path.');
  const selected = resolve(vaultPath);
  requireThat(exists(selected) && lstatSync(selected).isDirectory() && !lstatSync(selected).isSymbolicLink(), 'filesystem', 'The vault path must be an existing directory, not a symlink.');
  const vault = realpathSync(selected), root = join(vault, 'Grok Bot');
  const rawProtected = join(homedir(), 'Library/Application Support/Grok Bot');
  const protectedPath = exists(rawProtected) ? realpathSync(rawProtected) : rawProtected;
  requireThat(!within(root, protectedPath) && !within(protectedPath, root), 'conflict', 'The destination overlaps Grok Bot application data. Choose another vault.');
  if (exists(root)) requireThat(lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink(), 'conflict', 'The output root is not a regular directory.');
  else { mkdirSync(root, { mode: 0o700 }); syncDirectory(vault); }
  return root;
}
export function checkedPath(root: string, rel: string, allowMissing = true): string {
  relativePath(rel); let current = root;
  requireThat(lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink() && realpathSync(root) === root, 'conflict', 'The canonical output root changed.');
  for (const [i, part] of rel.split('/').entries()) {
    current = join(current, part);
    if (!exists(current)) { requireThat(allowMissing, 'conflict', 'An expected archive path is missing.'); continue; }
    const info = lstatSync(current);
    requireThat(!info.isSymbolicLink(), 'conflict', 'Symlinks are not permitted in managed paths.');
    if (i < rel.split('/').length - 1) requireThat(info.isDirectory(), 'conflict', 'A file occupies a required directory.');
  }
  return current;
}
export function lockArchive(root: string): () => void {
  libc ??= native(); const path = join(root, '.grok-vault.lock'); let fd: number;
  try { fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600); syncDirectory(root); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  try {
    const info = fstatSync(fd);
    requireThat(info.isFile() && info.nlink === 1 && info.size === 0 && (info.mode & 0o777) === 0o600, 'conflict', 'The reserved lock file is invalid. Preserve it and inspect the destination.');
    requireThat(libc.symbols.flock(fd, 6) === 0, 'conflict', 'Another Grok Vault process is using this archive.');
  } catch (e) { closeSync(fd); throw e; }
  let closed = false; return () => { if (!closed) { closed = true; closeSync(fd); } };
}
export interface Tree { files: Map<string, Buffer>; paths: Map<string, 'file' | 'directory'>; residue: string[] }
export function scanTree(root: string): Tree {
  const tree: Tree = { files: new Map(), paths: new Map(), residue: [] };
  const walk = (dir: string, prefix: string) => {
    const names = readdirSync(dir).sort(), seen = new Set<string>();
    for (const name of names) {
      const rel = prefix ? `${prefix}/${name}` : name, path = join(dir, name), key = collisionKey(name);
      requireThat(!seen.has(key), 'conflict', 'Output paths collide under Unicode normalization or case folding.'); seen.add(key);
      if (name === '.grok-vault.lock' && !prefix) continue;
      if (name.startsWith('.grok-vault-')) { tree.residue.push(rel); continue; }
      requireThat(!reserved(name) || !prefix && name === '_export.md', 'conflict', 'An unexpected path occupies a reserved namespace.');
      const info = lstatSync(path);
      requireThat(!info.isSymbolicLink(), 'conflict', 'A symlink was found inside the output root.');
      if (info.isDirectory()) { tree.paths.set(rel, 'directory'); walk(path, rel); }
      else if (info.isFile()) {
        tree.paths.set(rel, 'file');
        // Inspect only frontmatter candidates. Unrelated binary/large files remain untouched.
        const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const prefixBytes = Buffer.alloc(4);
        try { readSync(fd, prefixBytes, 0, 4, 0); } finally { closeSync(fd); }
        if (rel === '_export.md' || prefixBytes.equals(Buffer.from('---\n'))) tree.files.set(rel, regularBytes(path));
      } else requireThat(false, 'conflict', 'A nonregular filesystem entry occupies the output tree.');
    }
  };
  walk(root, ''); return tree;
}
