import { release } from 'node:os';
import { diagnostic, ExportError } from '../diagnostics/errors';
import { BrowserSource } from '../source/browser';
import { exportVault } from '../export/run';
import { VERSION } from '../version';
import type { Plan } from '../export/archive';

export const HELP = `Grok Vault ${VERSION} — macOS conversation archive\n\nUsage: grok-vault export <vault-path>\n       grok-vault --help\n       grok-vault --version\n\nThe vault path must be an existing directory. Sign in through your browser.\nOne account; all discovered bots and sessions; no total message or page cap.\n\nExports after two matching full-account scans. The service does not provide an\natomic snapshot guarantee. Unverified additional-session inventories are reported\nin Grok Bot/_export.md. Read errors and changing histories prevent publication.\n`;
export function exportSummary(result: Plan): string {
  const coverage = result.coverage === 'observed-retained-history'
    ? `Coverage: observed history from two matching full-account scans; ${result.unverifiedSessionInventories} bot session inventories unverified. No atomic snapshot guarantee. See Grok Bot/_export.md.`
    : 'History boundary: verified by Grok Bot/_export.md.';
  return `Exported: ${result.conversations} conversations, ${result.messages} text messages, ${result.excluded} classified exclusions. Notes: ${result.created} created, ${result.updated} updated, ${result.unchanged} unchanged. ${coverage}`;
}
export async function main(args: string[]): Promise<number> {
  if (args.length === 1 && args[0] === '--help') { console.log(HELP); return 0; }
  if (args.length === 1 && args[0] === '--version') { console.log(`grok-vault ${VERSION} (Bun ${Bun.version}+${Bun.revision.slice(0, 9)})`); return 0; }
  try {
    if (args.length !== 2 || args[0] !== 'export' || !args[1] || args[1].startsWith('-')) throw new ExportError('usage', 'Use grok-vault export <vault-path>, --help, or --version.');
    if (process.platform !== 'darwin' || process.arch !== 'arm64' || Number(release().split('.')[0]) < 22) throw new ExportError('platform', 'Apple Silicon macOS 13 or later is required.');
    if (process.env.BUN_OPTIONS !== undefined || process.env.BUN_BE_BUN !== undefined) throw new ExportError('platform', 'Unset BUN_OPTIONS and BUN_BE_BUN before running the standalone exporter.');
    const abort = new AbortController(), cancel = () => abort.abort();
    process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
    const progress = (message: string) => console.error(message);
    const source = new BrowserSource(async url => {
      progress('Opening browser sign-in. Complete sign-in there; press Ctrl+C to cancel.');
      const child = Bun.spawn(['/usr/bin/open', url], { stdout: 'ignore', stderr: 'ignore', env: { PATH: '/usr/bin:/bin' } });
      if (await child.exited !== 0) throw new ExportError('auth', 'Could not open browser sign-in. Set a default browser and retry.');
    }, progress);
    try {
      const result = await exportVault(args[1], source, abort.signal, progress);
      console.log(exportSummary(result));
      return 0;
    } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
  } catch (error) { console.error(diagnostic(error)); return 1; }
}
if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
