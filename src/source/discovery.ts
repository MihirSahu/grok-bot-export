import type { Agent } from '../model';
import { array, compare, record, stable, string } from '../validate';
import { requireThat } from '../diagnostics/errors';
import { Service, endpoint } from './http';

export interface AgentRoute { id: string; gateway: boolean; central: boolean; harness: 'box' | 'temporal' }
export interface BotInventory { agents: Agent[]; routes: AgentRoute[] }

function list(value: unknown, field: 'id' | 'agentId'): Map<string, Agent> {
  const result = new Map<string, Agent>();
  for (const item of array(value)) {
    const r = record(item), id = string(r[field]);
    requireThat(!result.has(id), 'coverage', 'Duplicate canonical bot ID in a roster.');
    const name = r.name === undefined || r.name === '' ? 'Unnamed Agent' : string(r.name);
    for (const k of ['isGroup', 'isHiddenFromSidebar']) requireThat(r[k] === undefined || typeof r[k] === 'boolean', 'schema', 'Invalid roster metadata.');
    result.set(id, { id, name, group: r.isGroup === true || r.kind === 'GROK_BOT_AGENT_KIND_ROOM' || r.kind === 2, hidden: r.isHiddenFromSidebar === true });
  }
  return result;
}
export function unionRoster(gateway: unknown, count: unknown, server: unknown): Agent[] {
  const g = list(gateway, 'id'), s = list(server, 'agentId');
  requireThat(typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 && g.size === count, 'coverage', 'Gateway roster and count disagree.');
  for (const [id, bot] of s) {
    const existing = g.get(id);
    requireThat(!existing || (existing.name === bot.name && existing.group === bot.group), 'coverage', 'Conflicting metadata for a canonical bot ID.');
    g.set(id, existing ? { ...bot, hidden: bot.hidden || existing.hidden } : bot);
  }
  return [...g.values()].sort((a, b) => compare(a.id, b.id));
}
export function botInventory(gateway: unknown, count: unknown, server: unknown): BotInventory {
  const agents = unionRoster(gateway, count, server);
  const g = new Map(array(gateway).map(value => { const r = record(value); return [string(r.id), r] as const; }));
  const s = new Map(array(server).map(value => { const r = record(value); return [string(r.agentId), r] as const; }));
  const routes = agents.map(({ id }): AgentRoute => {
    const gatewayBot = g.get(id), centralBot = s.get(id);
    // Grok Bot 0.44.0's rosterHarnessOf defaults an omitted gateway harness to box.
    const a = gatewayBot?.harness, b = centralBot?.harness;
    for (const harness of [a, b]) requireThat(harness === undefined || harness === 'box' || harness === 'temporal', 'schema', 'Unsupported bot harness.');
    requireThat(a === undefined || b === undefined || a === b, 'coverage', 'Conflicting bot routing metadata.');
    requireThat(centralBot?.viewerIsOwner !== false, 'coverage', 'Shared bot session access has not been validated. No archive was published.');
    return { id, gateway: g.has(id), central: s.has(id), harness: (b ?? a ?? 'box') as AgentRoute['harness'] };
  });
  return { agents, routes };
}
export class Discovery {
  #gateway: { url: string; token: string; network: string } | null = null;
  constructor(private service: Service) {}
  close() { this.#gateway = null; }
  async connect(signal: AbortSignal) {
    const state = await this.service.rpc('GetSandBoxRunState', {}, signal);
    requireThat(state.state === 3 || state.state === 'SAND_BOX_RUN_STATE_RUNNING', 'unavailable', 'The account cloud box is not running. Start it in Grok Bot, then retry. The exporter will not wake it.');
    const data = await this.service.rpc('EnsureSandBox', { wake: false }, signal);
    const url = endpoint(data.gatewayUrl);
    requireThat(!url.search, 'schema', 'Invalid gateway URL.');
    this.#gateway = { url: url.href.replace(/\/$/, ''), token: string(data.gatewayToken), network: string(data.networkToken) };
  }
  async gateway(method: 'listAgents' | 'countAgents', signal: AbortSignal): Promise<unknown> {
    requireThat(this.#gateway && ['listAgents', 'countAgents'].includes(method), 'schema', 'Gateway is disconnected or method is not allowed.');
    const g = this.#gateway;
    return this.service.http.json(`${g.url}/api/${method}`, { method: 'POST', headers: {
      'Content-Type': 'application/json', 'x-sand-slim-avatars': '1', Authorization: `Bearer ${g.token}`, 'x-anyrun-network-token': g.network,
    }, body: '{}' }, signal);
  }
  async inventory(signal: AbortSignal): Promise<BotInventory> {
    const first = await this.gateway('listAgents', signal);
    const count = await this.gateway('countAgents', signal);
    const server = await this.service.rpc('ListGrokBotAgents', { includeTeamAgents: true }, signal);
    const bots = botInventory(first, count, server.agents ?? []);
    const again = botInventory(await this.gateway('listAgents', signal), await this.gateway('countAgents', signal),
      (await this.service.rpc('ListGrokBotAgents', { includeTeamAgents: true }, signal)).agents ?? []);
    requireThat(stable(bots) === stable(again), 'consistency', 'The bot inventory changed during discovery. Retry.');
    return bots;
  }
  async roster(signal: AbortSignal): Promise<Agent[]> { return (await this.inventory(signal)).agents; }
}
