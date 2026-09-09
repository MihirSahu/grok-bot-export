import type { Agent, Conversation, History, Message } from '../model';
import { normalize, rawRow, type RawRow } from '../normalize/messages';
import { array, hash, integer, json, record, stable, string } from '../validate';
import { ExportError, requireThat } from '../diagnostics/errors';
import { delay, endpoint, Service } from './http';

export type Rpc = (method: string, payload: Record<string, unknown>, signal: AbortSignal) => Promise<Record<string, unknown>>;
export interface HistoryTransport { rpc: Rpc; blob(url: string, signal: AbortSignal): Promise<Uint8Array> }
export const historyTransport = (service: Service): HistoryTransport => ({
  rpc: service.rpc.bind(service), blob: (url, signal) => service.http.bytes(url, {}, signal),
});
function sameVersion(a: RawRow, b: RawRow) { return a.seq === b.seq && a.updatedSeq === b.updatedSeq && a.entryId === b.entryId && a.entryKind === b.entryKind; }
export async function resolveBody(transport: HistoryTransport, original: RawRow, c: Conversation, generation: number, signal: AbortSignal): Promise<unknown> {
  let row = original;
  if (!row.body && !row.blobHash && row.bodyOmitted) {
    requireThat(BigInt(row.seq) < 18446744073709551615n, 'coverage', 'An omitted body cannot be addressed without sequence overflow.');
    const page = await transport.rpc('ListGrokBotTranscriptEntries', { agentId: c.agentId, sessionId: c.sessionId, generation, beforeSeq: String(BigInt(row.seq) + 1n), limit: 1 }, signal);
    requireThat(integer(page.generation ?? 0, 0xffffffff) === generation, 'consistency', 'History generation changed while resolving a body.');
    const matches = array(page.entries ?? []).map(rawRow).filter(r => r.seq === row.seq);
    requireThat(matches.length === 1 && sameVersion(row, matches[0]!), 'consistency', 'The omitted row changed or disappeared.');
    row = matches[0]!;
  }
  let bytes: Uint8Array;
  if (row.body) {
    requireThat(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(row.body), 'schema', 'Invalid base64 body.');
    bytes = Buffer.from(row.body, 'base64');
  } else if (row.blobHash) {
    requireThat(/^[0-9a-f]{64}$/.test(row.blobHash), 'schema', 'Unsupported blob hash.');
    const relPath = `blobs/${row.blobHash}`;
    const data = await transport.rpc('PresignSandBoxStoreReads', { relPaths: [relPath] }, signal);
    const found = array(data.instructions ?? []).map(record).filter(r => r.relPath === relPath);
    requireThat(found.length === 1, 'coverage', 'Missing blob-read instruction.');
    const url = endpoint(string(found[0]!.url));
    // Only service-issued object-storage origins; no auth header follows the URL.
    requireThat(/\.(amazonaws\.com|r2\.cloudflarestorage\.com|storage\.googleapis\.com)$/.test(url.hostname) || url.hostname === 'storage.googleapis.com', 'schema', 'Unvalidated storage origin.');
    bytes = await transport.blob(url.href, signal);
    requireThat(hash(bytes) === `sha256:${row.blobHash}`, 'schema', 'Blob content hash mismatch.');
  } else { requireThat(false, 'coverage', 'An unresolved transcript body prevents a complete export.'); }
  return json(bytes);
}
export async function scanHistory(transport: HistoryTransport, c: Conversation, roster: Agent[], signal: AbortSignal, limit = 200): Promise<History> {
  integer(limit, 500); requireThat(limit > 0, 'schema', 'Invalid page size.');
  let before: bigint | undefined, generation: number | undefined;
  let rawCount = 0, maxUpdated: bigint | null = null;
  const fingerprint = createHash('sha256');
  const seen = new Set<string>(), ids = new Set<string>(), messages: Message[] = [], exclusions: Record<string, number> = Object.create(null);
  let newest: string | null = null, oldest: string | null = null;
  while (true) {
    signal.throwIfAborted();
    const data = await transport.rpc('ListGrokBotTranscriptEntries', { agentId: c.agentId, sessionId: c.sessionId, limit,
      ...(generation === undefined ? {} : { generation }), ...(before === undefined ? {} : { beforeSeq: String(before) }) }, signal);
    const current = integer(data.generation ?? 0, 0xffffffff);
    requireThat(Object.keys(data).every(k => k === 'entries' || k === 'generation'), 'schema', 'Unsupported history response shape.');
    generation ??= current;
    requireThat(current === generation, 'consistency', 'History generation changed during pagination.');
    const rows = array(data.entries ?? []).map(rawRow);
    if (!rows.length) break;
    let previous = before;
    for (const row of rows) {
      const seq = BigInt(row.seq);
      requireThat((previous === undefined || seq < previous) && !seen.has(row.seq), 'coverage', 'History cursor repeated, overlapped, or moved backward.');
      seen.add(row.seq); previous = seq; newest ??= row.seq; oldest = row.seq;
      const updated = BigInt(row.updatedSeq); if (maxUpdated === null || updated > maxUpdated) maxUpdated = updated;
      const body = await resolveBody(transport, row, c, generation, signal);
      fingerprint.update(hash(stable([row.seq, row.updatedSeq, row.entryKind, row.entryId ?? null, body])));
      const id = string(record(body).id);
      requireThat(!ids.has(id), 'schema', 'Distinct source rows have the same entry ID.'); ids.add(id);
      const result = normalize(row, body, c, generation, roster);
      if (typeof result === 'string') exclusions[result] = (exclusions[result] ?? 0) + 1;
      else messages.push(result);
      rawCount++; integer(rawCount);
    }
    before = previous;
  }
  messages.reverse().forEach((m, i) => { m.sourceOrder = i; });
  requireThat(rawCount === messages.length + Object.values(exclusions).reduce((a, b) => a + b, 0), 'coverage', 'Raw-row accounting failed.');
  return { conversation: c, messages, rawCount, exclusions, generation: generation!, rawFingerprint: `sha256:${fingerprint.digest('hex')}`, oldestSequence: oldest, newestSequence: newest,
    maxUpdatedSequence: maxUpdated === null ? null : String(maxUpdated), termination: 'empty-raw-page' };
}
export const historyFingerprint = (history: History) => hash(stable(history));

/** Bounded retry improves read stability; equal scans are still not a certificate. */
export async function readStableHistory(transport: HistoryTransport, c: Conversation, roster: Agent[], signal: AbortSignal, pause = delay): Promise<History> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const first = await scanHistory(transport, c, roster, signal), second = await scanHistory(transport, c, roster, signal);
      requireThat(historyFingerprint(first) === historyFingerprint(second), 'consistency', 'Two complete history reads disagreed. Retry after the source settles.');
      return first;
    } catch (e) {
      if (!(e instanceof ExportError) || e.code !== 'consistency' || attempt === 2) throw e;
      await pause(1000 * 2 ** attempt, signal);
    }
  }
  throw new ExportError('consistency', 'History did not settle within the retry policy.');
}
import { createHash } from 'node:crypto';
