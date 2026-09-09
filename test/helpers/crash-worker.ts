import { exportVault } from '../../src/export/run';
import { lockArchive, canonicalRoot } from '../../src/export/filesystem';
import { source, signal } from '../fixtures';

const [vault, point] = process.argv.slice(2);
if (!vault || !point) process.exit(2);
if (point === 'hold-lock') {
  const unlock = lockArchive(canonicalRoot(vault));
  console.log('locked');
  for await (const _ of Bun.stdin.stream()) break;
  unlock();
} else {
  await exportVault(vault, source(), signal(), () => {}, p => {
    if (p === point) process.kill(process.pid, 'SIGKILL');
  });
}
