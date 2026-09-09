import { caseFold } from 'unicode-case-folding';
import { requireThat } from '../diagnostics/errors';
import { hash, string } from '../validate';

export const collisionKey = (s: string) => caseFold(s.normalize('NFD')).normalize('NFD');
export function reserved(s: string): boolean {
  const k = collisionKey(s); return k === '_export.md' || k === '.grok-vault.lock' || k.startsWith('.grok-vault-');
}
export function safeComponent(value: string): string {
  const s = string(value, true).normalize('NFC').replace(/[\\/:\u0000-\u001f\u007f-\u009f]/g, '_').trim();
  return s && s !== '.' && s !== '..' ? s : 'Unnamed Agent';
}
function truncate(s: string, max: number): string {
  let out = '';
  for (const { segment } of new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(s)) {
    if (Buffer.byteLength(out + segment) > max) break;
    out += segment;
  }
  return out || 'Agent';
}
/** occupied includes files and directories; no display-name matching is identity. */
export function allocateName(display: string, identity: string, occupied: Set<string>, alwaysSuffix = false): string {
  let base = safeComponent(display);
  if (reserved(base)) base = `Agent — ${base}`;
  const digest = hash(identity).slice(7);
  for (let length = alwaysSuffix ? 8 : 0; length <= 64; length = length === 0 ? 8 : length + 4) {
    const suffix = length ? ` — ${digest.slice(0, length)}` : '';
    if (!length && Buffer.byteLength(base) > 255) continue;
    const candidate = truncate(base, 255 - Buffer.byteLength(suffix)) + suffix;
    if (!reserved(candidate) && !occupied.has(collisionKey(candidate))) { occupied.add(collisionKey(candidate)); return candidate; }
  }
  requireThat(false, 'conflict', 'Cannot allocate a collision-free output directory.');
}
export function relativePath(value: unknown): string {
  const p = string(value);
  requireThat(!p.startsWith('/') && !p.includes('\\') && !p.includes('\0') && p.split('/').every(c => c !== '' && c !== '.' && c !== '..' && c === safeComponent(c) && Buffer.byteLength(c) <= 255), 'conflict', 'Unsafe archive-relative path.');
  return p;
}
export function conversationDirectory(p: string, sessionId: string): string {
  relativePath(p); const parts = p.split('/');
  requireThat(!reserved(parts[0]!) && (sessionId === '' ? parts.length === 1 : parts.length === 3 && parts[1] === 'Sessions' && !reserved(parts[2]!)), 'conflict', 'Invalid conversation directory.');
  return p;
}
