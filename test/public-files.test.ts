import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditRepository, inspectText } from '../scripts/check-public-files';

function repository() {
  const cwd = mkdtempSync(join(tmpdir(), 'grok-public-test-'));
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd });
    if (result.status !== 0) throw new Error('Synthetic Git setup failed.');
  };
  git('init', '-q');
  return { cwd, git, write: (file: string, value: string) => writeFileSync(join(cwd, file), value),
    dispose: () => rmSync(cwd, { recursive: true, force: true }) };
}

test('publication guard checks staged secrets after the worktree has been cleaned, without exposing values', () => {
  const r = repository(), token = 'ghp_' + 'a'.repeat(36);
  try {
    r.write('config.ts', `const credential = '${token}';\n`); r.git('add', 'config.ts');
    r.write('config.ts', 'const credential = undefined;\n');
    const found = auditRepository(r.cwd);
    expect(found).toEqual([{ file: 'config.ts', source: 'index', line: 1, reason: 'GitHub token' }]);
    expect(JSON.stringify(found)).not.toContain(token);
    r.git('add', 'config.ts'); expect(auditRepository(r.cwd)).toEqual([]);
  } finally { r.dispose(); }
});

test('publication guard rejects ignored files that have been force-added to Git', () => {
  const r = repository();
  try {
    r.write('.gitignore', '.env\n'); r.write('.env', 'ACCOUNT=fictional\n');
    expect(auditRepository(r.cwd)).toEqual([]);
    r.git('add', '-f', '.env');
    expect(auditRepository(r.cwd)).toContainEqual({ file: '.env', source: 'index', line: 1, reason: 'tracked file matches .gitignore' });
  } finally { r.dispose(); }
});

test('publication guard detects renamed archives but permits embedded documentation examples', () => {
  const archive = '---\n{"generated_by":"grok-vault"}\n---\nFictional message\n';
  expect(inspectText('renamed.md', 'worktree', archive).map(f => f.reason)).toEqual(['generated conversation archive']);
  expect(inspectText('README.md', 'worktree', '# Example\n```md\n' + archive + '```\n')).toEqual([]);
  const r = repository();
  try {
    r.write('renamed.md', archive);
    expect(auditRepository(r.cwd).map(f => f.reason)).toEqual(['generated conversation archive']);
  } finally { r.dispose(); }
});

test('ignore rules cover nested exports, credentials, captures, generated output and local research', () => {
  const r = repository();
  try {
    r.write('.gitignore', readFileSync(new URL('../.gitignore', import.meta.url), 'utf8'));
    const privatePaths = ['.local/research/report.json', 'research/capture.json', 'vault/Grok Bot/Bot/2026-01-01.md',
      'vault/.grok-vault-transaction/journal.json', 'nested/0.payload', '.env', 'nested/.env.production', '.npmrc',
      'nested/credentials.json', 'nested/access-token.json', 'signing/private.key', 'signing/cert.p12',
      'request.har', 'transcript.blob', 'cache.sqlite3', 'cache.db-wal', 'node_modules/pkg/index.js',
      'dist/grok-vault', 'coverage/results.json', 'scripts/__pycache__/probe.pyc', '.codex/settings.json'];
    const result = spawnSync('git', ['check-ignore', '--no-index', '--stdin', '-z'], { cwd: r.cwd, input: privatePaths.join('\0') + '\0', encoding: 'utf8' });
    expect(result.status).toBe(0); expect(result.stdout.split('\0').filter(Boolean)).toEqual(privatePaths);
    const publicPaths = ['src/cli/main.ts', 'test/fixtures.ts', 'scripts/check-public-files.ts', 'bun.lock', 'README.md', 'docs/source-contract.md', '.env.example'];
    const allowed = spawnSync('git', ['check-ignore', '--no-index', '--stdin', '-z'], { cwd: r.cwd, input: publicPaths.join('\0') + '\0', encoding: 'utf8' });
    expect(allowed.status).toBe(1); expect(allowed.stdout).toBe('');
  } finally { r.dispose(); }
});
