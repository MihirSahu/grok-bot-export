// Read-only live validation of the same account reader used by the CLI.
// Credentials, identities, and transcript contents remain in memory.
import { login } from '../src/source/auth';
import { Service } from '../src/source/http';
import { Discovery } from '../src/source/discovery';
import { historyTransport } from '../src/source/history';
import { readAccount } from '../src/source/account';
import { diagnostic, ExportError } from '../src/diagnostics/errors';

const abort = new AbortController(), cancel = () => abort.abort();
process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
let service: Service | undefined, discovery: Discovery | undefined;
try {
  const session = await login(abort.signal, async url => {
    console.error('Opening browser sign-in for read-only validation. No archive will be written.');
    const child = Bun.spawn(['/usr/bin/open', url], { stdout: 'ignore', stderr: 'ignore', env: { PATH: '/usr/bin:/bin' } });
    if (await child.exited !== 0) throw new ExportError('auth', 'Could not open browser sign-in.');
  });
  service = new Service(session.token); session.token = '';
  discovery = new Discovery(service); await discovery.connect(abort.signal);
  const result = await readAccount(session.accountId, discovery, historyTransport(service), abort.signal, console.error);
  console.log(JSON.stringify({ bots: result.bots.agents.length, conversations: result.histories.length,
    rawRows: result.histories.reduce((n, h) => n + h.rawCount, 0), textMessages: result.histories.reduce((n, h) => n + h.messages.length, 0),
    unverifiedSessionInventories: result.sessions.filter(s => s.scope === 'default-only-unverified').length,
    matchingFullAccountScans: 2, archiveWritten: false, credentialsSaved: false }));
} catch (error) { console.error(diagnostic(error)); process.exitCode = 1; }
finally { discovery?.close(); service?.close(); process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
