import { mkdirSync, writeFileSync } from 'node:fs';
import { hash } from '../src/validate';
import { VERSION, BUN_VERSION, BUN_REVISION } from '../src/version';

if (Bun.version !== BUN_VERSION || Bun.revision !== BUN_REVISION) throw new Error('Build requires Bun 1.4.2 revision 744846f84.');
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Build and validation require an Apple Silicon Mac.');
mkdirSync('dist', { recursive: true });
const result = await Bun.build({
  entrypoints: ['src/cli/main.ts'], target: 'bun', minify: true,
  compile: { target: 'bun-darwin-arm64', outfile: 'dist/grok-vault',
    autoloadDotenv: false, autoloadBunfig: false, autoloadTsconfig: false, autoloadPackageJson: false },
});
if (!result.success) { for (const log of result.logs) console.error(log.message); process.exit(1); }
const digest = hash(new Uint8Array(await Bun.file('dist/grok-vault').arrayBuffer())).slice(7);
writeFileSync('dist/SHA256SUMS', `${digest}  grok-vault\n`);
writeFileSync('dist/build.json', JSON.stringify({ product: 'grok-vault', version: VERSION, runtime: Bun.version, revision: Bun.revision,
  target: 'bun-darwin-arm64', autoload: false, sha256: digest, release: false,
  exportPolicy: 'two-matching-full-account-scans', coverage: 'observed-retained-history',
  sourceLimitations: ['unverified-additional-session-inventories-reported', 'no-atomic-snapshot-guarantee'],
  blockedGates: ['real-long-history-and-blob-cases', 'macos-13', 'signing-and-notarization', 'outbound-trace-and-obsidian'] }, null, 2) + '\n');
console.log(`Built dist/grok-vault (${VERSION}); development artifact, release gates remain open.`);
