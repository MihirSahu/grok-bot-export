import type { Source } from '../model';
import { ExportError } from '../diagnostics/errors';
import { planArchive, type Plan, validateArchive } from './archive';
import { canonicalRoot, lockArchive, scanTree } from './filesystem';
import { publish, recover, type FaultHook } from './transaction';

export async function exportVault(vaultPath: string, source: Source, signal: AbortSignal, progress: (message: string) => void = () => {}, hook?: FaultHook): Promise<Plan> {
  let unlock: (() => void) | undefined;
  try {
    if (signal.aborted) throw new ExportError('cancelled', 'Export cancelled.');
    const root = canonicalRoot(vaultPath); unlock = lockArchive(root);
    const recovered = recover(root, hook);
    if (recovered) progress(`Recovered ${recovered} previously committed files before starting the new export.`);
    const tree = scanTree(root); validateArchive(tree.files);
    if (tree.residue.length) progress('Preserved inert staging or cleanup residue. See the recovery instructions before removing it.');
    const snapshot = await source.snapshot(signal);
    if (signal.aborted) throw new ExportError('cancelled', 'Export cancelled.');
    const plan = planArchive(tree, snapshot);
    publish(root, plan, hook);
    return plan;
  } finally { source.close(); unlock?.(); }
}
