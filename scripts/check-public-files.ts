// Offline publication guard. Findings contain locations and rule names, never matched values.
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Finding { file: string; source: 'worktree' | 'index'; line: number; reason: string }
const patterns: [string, RegExp][] = [
  ['private key', /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/],
  ['JWT credential', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
  ['API secret', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/],
  ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  ['credential in URL', /[?&](?:access_token|token|X-Amz-Signature)=[A-Za-z0-9_%.-]{16,}/i],
];

export function inspectText(file: string, source: Finding['source'], value: string): Finding[] {
  const found: Finding[] = [];
  for (const [index, line] of value.split('\n').entries()) {
    for (const [reason, pattern] of patterns) if (pattern.test(line)) found.push({ file, source, line: index + 1, reason });
  }
  const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(value)?.[1];
  if (header && /["']?generated_by["']?\s*:\s*["']?grok-vault\b/.test(header)) {
    found.push({ file, source, line: 1, reason: 'generated conversation archive' });
  }
  if (value.trimStart().startsWith('{')) {
    try {
      const data = JSON.parse(value);
      if (data?.generated_by === 'grok-vault') found.push({ file, source, line: 1, reason: 'export recovery data' });
    } catch { /* Source files and documentation are not necessarily JSON. */ }
  }
  return found;
}

export function auditRepository(cwd: string): Finding[] {
  function git(args: string[], input?: string, allowNoMatch = false): Buffer {
    const result = spawnSync('git', args, { cwd, input, maxBuffer: 16 * 1024 * 1024 });
    if (result.error || (result.status !== 0 && !(allowNoMatch && result.status === 1))) {
      throw new Error('Could not complete the Git publication audit.');
    }
    return result.stdout;
  }
  const files = [...new Set(git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).toString().split('\0').filter(Boolean))];
  const found: Finding[] = [];
  function inspect(file: string, source: Finding['source'], bytes: Buffer) {
    try {
      const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (value.includes('\0')) throw new Error('binary');
      found.push(...inspectText(file, source, value));
    } catch { found.push({ file, source, line: 1, reason: 'non-text file requires manual publication review' }); }
  }
  if (files.length) {
    const ignored = git(['check-ignore', '--no-index', '--stdin', '-z'], files.join('\0') + '\0', true).toString().split('\0').filter(Boolean);
    for (const file of ignored) found.push({ file, source: 'index', line: 1, reason: 'tracked file matches .gitignore' });
  }
  for (const file of files) {
    const path = join(cwd, file);
    let stat;
    try { stat = lstatSync(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; // Still inspect its staged contents below.
      throw error;
    }
    if (!stat.isFile()) found.push({ file, source: 'worktree', line: 1, reason: 'non-regular file requires manual publication review' });
    else inspect(file, 'worktree', readFileSync(path));
  }
  // The index can contain a secret even when its working copy has already been cleaned.
  for (const entry of git(['ls-files', '--stage', '-z']).toString().split('\0').filter(Boolean)) {
    const tab = entry.indexOf('\t'), file = entry.slice(tab + 1);
    const [mode, oid, stage] = entry.slice(0, tab).split(' ');
    if (!/^100(?:644|755)$/.test(mode!) || stage !== '0') {
      found.push({ file, source: 'index', line: 1, reason: 'special or unmerged index entry requires review' });
    } else inspect(file, 'index', git(['cat-file', 'blob', oid!]));
  }
  return found;
}

if (import.meta.main) {
  try {
    const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error('Run this check inside the repository.');
    const found = auditRepository(result.stdout.trim());
    for (const f of found) console.error(`${JSON.stringify(f.file)}:${f.line} (${f.source}): ${f.reason}`);
    if (found.length) process.exitCode = 1;
    else console.log('Publication check passed for current and staged files. History and personal details still require human review.');
  } catch { console.error('Publication check could not complete; do not treat this as a clean scan.'); process.exitCode = 1; }
}
