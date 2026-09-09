import { createHash } from 'node:crypto';
import { parseDocument } from 'yaml';
import { requireThat } from './diagnostics/errors';

export const hash = (data: string | Uint8Array) => 'sha256:' + createHash('sha256').update(data).digest('hex');
export const isHash = (v: unknown): v is string => typeof v === 'string' && /^sha256:[0-9a-f]{64}$/.test(v);
export function record(v: unknown): Record<string, unknown> {
  requireThat(v !== null && typeof v === 'object' && !Array.isArray(v), 'schema', 'Expected an object.');
  return v as Record<string, unknown>;
}
export function array(v: unknown): unknown[] {
  requireThat(Array.isArray(v), 'schema', 'Expected an array.'); return v;
}
export function string(v: unknown, empty = false): string {
  requireThat(typeof v === 'string' && (empty || v.length > 0), 'schema', 'Expected a valid string.');
  requireThat(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v), 'schema', 'Unpaired Unicode surrogate in source or metadata.');
  return v;
}
export function integer(v: unknown, max = Number.MAX_SAFE_INTEGER): number {
  requireThat(typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max, 'schema', 'Expected a nonnegative safe integer.'); return v;
}
export function uint64(v: unknown): string {
  if (typeof v === 'number') { integer(v); v = String(v); }
  const s = string(v);
  requireThat(/^(0|[1-9][0-9]*)$/.test(s) && BigInt(s) <= 18446744073709551615n, 'schema', 'Invalid or lossy uint64 sequence.');
  return s;
}
export function timestamp(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const n = integer(v, 8_640_000_000_000_000);
  requireThat(n > 0, 'schema', 'Malformed source timestamp.');
  const iso = new Date(n).toISOString();
  requireThat(/^\d{4}-/.test(iso), 'schema', 'Source date is outside the supported calendar range.'); return iso;
}
export function isoTimestamp(v: unknown): string {
  const s = string(v); const n = Date.parse(s);
  requireThat(Number.isFinite(n) && new Date(n).toISOString() === s, 'schema', 'Invalid canonical timestamp.'); return s;
}
const checkedZones = new Set<string>();
export function timezone(v: unknown): string {
  const s = string(v);
  if (checkedZones.has(s)) return s;
  try { new Intl.DateTimeFormat('en-US', { timeZone: s }).format(); }
  catch { requireThat(false, 'schema', 'Invalid archive timezone.'); }
  checkedZones.add(s); return s;
}
export function utf8(bytes: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { requireThat(false, 'schema', 'Invalid UTF-8.'); }
}
/** JSON must reject duplicate keys and unsafe numeric uint64s before normalization. */
export function json(bytes: Uint8Array | string): unknown {
  const s = typeof bytes === 'string' ? bytes : utf8(bytes);
  let result: unknown;
  try { result = JSON.parse(s); } catch { requireThat(false, 'schema', 'Malformed JSON.'); }
  const doc = parseDocument(s, { uniqueKeys: true, schema: 'json', strict: true });
  requireThat(doc.errors.length === 0, 'schema', 'Duplicate or malformed JSON keys.');
  return result;
}
export function stable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => compare(a, b)).map(([k, v]) => JSON.stringify(k) + ':' + stable(v)).join(',') + '}';
  return JSON.stringify(value);
}
export const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
