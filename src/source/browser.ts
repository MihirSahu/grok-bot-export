import type { Snapshot, Source } from '../model';
import { login } from './auth';
import { Discovery } from './discovery';
import { historyTransport } from './history';
import { Http, Service } from './http';
import { readAccount } from './account';
import { hash, stable } from '../validate';

/** Production has no fixture-file, alternate origin, token, or certificate override. */
export class BrowserSource implements Source {
  #service: Service | null = null;
  #discovery: Discovery | null = null;
  constructor(private openBrowser: (url: string) => Promise<void>, private progress: (message: string) => void = () => {}, private http = new Http()) {}
  close() { this.#discovery?.close(); this.#service?.close(); this.#discovery = null; this.#service = null; }
  async snapshot(signal: AbortSignal): Promise<Snapshot> {
    const session = await login(signal, this.openBrowser, this.http);
    this.#service = new Service(session.token, this.http); session.token = '';
    const accountId = session.accountId;
    const discovery = this.#discovery = new Discovery(this.#service);
    this.progress('Signed in. Discovering all account bots.');
    await discovery.connect(signal);
    const read = await readAccount(accountId, discovery, historyTransport(this.#service), signal, this.progress);
    this.progress('Two full-account scans matched. This is an observed export, not a verified atomic snapshot; coverage details will be recorded in _export.md.');
    return { accountId, agents: read.bots.agents, histories: read.histories, certificate: {
      contract: 'grok-bot-0.44.0/repeated-account-read-v1', consistency: 'matching-full-account-scans',
      boundary: hash(stable(read)), inventoryComplete: false, retentionBoundaryVerified: false, fullScanCount: 2,
      sessionCoverage: read.sessions.map(s => ({ agentId: s.agentId, scope: s.scope, sessionIds: s.sessions.map(v => v.id) })),
    } };
  }
}
