export type ErrorCode = 'usage' | 'auth' | 'cancelled' | 'unavailable' | 'schema' | 'coverage' | 'consistency' | 'conflict' | 'filesystem' | 'platform';

/** Messages are authored constants, never remote error bodies, paths, or transcripts. */
export class ExportError extends Error {
  constructor(readonly code: ErrorCode, message: string) { super(message); this.name = 'ExportError'; }
}
export function requireThat(value: unknown, code: ErrorCode, message: string): asserts value {
  if (!value) throw new ExportError(code, message);
}
export function diagnostic(error: unknown): string {
  return error instanceof ExportError ? `${error.code}: ${error.message}` : 'filesystem: Export stopped unexpectedly. Existing files and committed recovery data were preserved.';
}
