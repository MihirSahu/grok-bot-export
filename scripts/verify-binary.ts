import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { VERSION } from '../src/version';

const binary = resolve('dist/grok-vault');
if (!existsSync(binary)) throw new Error('Run bun run build first.');
const dir = mkdtempSync(join(tmpdir(), 'grok-vault-binary-'));
const env = { PATH: '/usr/bin:/bin', HOME: dir, TMPDIR: dir };
async function run(args: string[], extra: Record<string, string> = {}) {
  const child = Bun.spawn([binary, ...args], { cwd: dir, env: { ...env, ...extra }, stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}
function check(value: unknown, label: string): asserts value { if (!value) throw new Error(`Binary verification failed: ${label}`); }
try {
  writeFileSync(join(dir, '.env'), 'BUN_OPTIONS=synthetic-dotenv-sentinel\n');
  writeFileSync(join(dir, 'bunfig.toml'), 'preload = ["./preload.ts"]\n');
  writeFileSync(join(dir, 'preload.ts'), 'throw new Error("SYNTHETIC_PRELOAD_EXECUTED");\n');
  writeFileSync(join(dir, 'package.json'), '{ invalid synthetic package');
  writeFileSync(join(dir, 'tsconfig.json'), '{ invalid synthetic tsconfig');
  const help = await run(['--help']), version = await run(['--version']);
  check(help.code === 0 && help.stdout.includes('two matching full-account scans') && help.stdout.includes('Unverified additional-session inventories') && !help.stderr, 'help and configuration isolation');
  check(version.code === 0 && version.stdout.startsWith(`grok-vault ${VERSION}`), 'version');
  const invalid = await run(['export', join(dir, 'missing-vault')]);
  check(invalid.code === 1 && invalid.stderr.includes('existing directory') && !invalid.stderr.includes('BUN_OPTIONS'), 'no dotenv autoload');
  for (const args of [[], ['export'], ['export', dir, '--force'], ['export', '--token=synthetic']]) {
    const result = await run(args); check(result.code === 1 && result.stderr.startsWith('usage:'), 'CLI argument surface');
  }
  const vault = join(dir, 'vault'), root = join(vault, 'Grok Bot');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, '_export.md'), 'unrelated synthetic file');
  const conflict = await run(['export', vault]);
  check(conflict.code === 1 && conflict.stderr.includes('unrelated file occupies') && !conflict.stderr.includes('Opening browser'), 'native lock acquired before manifest conflict, without authentication');
  check(statSync(join(root, '.grok-vault.lock')).size === 0 && readFileSync(join(root, '_export.md'), 'utf8') === 'unrelated synthetic file', 'lock and unrelated-file preservation');
  const override = await run(['--help'], { BUN_OPTIONS: '--preload ./preload.ts' });
  const runtime = await run(['--version'], { BUN_BE_BUN: '1' });
  check(override.code !== 0 && override.stderr.includes('SYNTHETIC_PRELOAD_EXECUTED'), 'documented BUN_OPTIONS behavior');
  check(runtime.stdout.trim() === '1.4.2', 'documented BUN_BE_BUN behavior');
  const report = { artifact: 'dist/grok-vault', runtime: '1.4.2+744846f84', platform: `${process.platform}-${process.arch}`,
    helpAndVersion: true, invalidArguments: true, configAutoloadDisabled: true, nativeLockAndConflictHandling: true,
    unsupportedOverrides: { BUN_OPTIONS_executesPreload: true, BUN_BE_BUN_changesEntrypoint: true },
    networkRequestsNeeded: false, liveExportValidated: false, minimumMacOSValidated: false };
  writeFileSync(resolve('dist/binary-validation.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('Standalone binary checks passed: CLI surface, configuration isolation, and documented runtime overrides. No login or source requests were made.');
} finally { rmSync(dir, { recursive: true, force: true }); }
