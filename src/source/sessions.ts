import { requireThat } from '../diagnostics/errors';
import { array, compare, record, string } from '../validate';
import type { AgentRoute } from './discovery';
import type { Rpc } from './history';
import { HttpError } from './http';

export interface SessionInventory {
  agentId: string;
  scope: 'listed' | 'default-only-unverified';
  sessions: { id: string; name: string }[];
  records: Record<string, unknown>[];
}
const sessionNames: Record<string, string> = {
  '1': 'Main', GROK_BOT_AGENT_SESSION_KIND_MAIN: 'Main',
  '2': 'Slack DM', GROK_BOT_AGENT_SESSION_KIND_SLACK_DM: 'Slack DM',
  '3': 'Slack thread', GROK_BOT_AGENT_SESSION_KIND_SLACK_THREAD: 'Slack thread',
  '4': 'DM', GROK_BOT_AGENT_SESSION_KIND_DM: 'DM',
};

/** A missing registry is evidence of uncertainty, never an authoritative empty list. */
export async function sessionInventory(rpc: Rpc, route: AgentRoute, signal: AbortSignal): Promise<SessionInventory> {
  let data: Record<string, unknown>;
  try { data = await rpc('ListGrokBotAgentSessions', { agentId: route.id }, signal); }
  catch (error) {
    if (!(error instanceof HttpError && error.status === 404 && route.gateway && !route.central && route.harness === 'box')) throw error;
    return { agentId: route.id, scope: 'default-only-unverified', sessions: [{ id: '', name: '' }], records: [] };
  }
  requireThat(Object.keys(data).every(k => k === 'sessions'), 'schema', 'Unsupported session inventory response.');
  const records = array(data.sessions ?? []).map(record);
  const seen = new Set<string>(), sessions: SessionInventory['sessions'] = [];
  for (const r of records) {
    requireThat(r.agentId === undefined || r.agentId === route.id, 'coverage', 'A session belongs to a different bot.');
    // Proto JSON omits the default empty-string ID; the renderer normalizes it to ''.
    const id = string(r.sessionId ?? '', true);
    requireThat(!seen.has(id), 'coverage', 'Duplicate session ID in the bot inventory.'); seen.add(id);
    sessions.push({ id, name: id === '' ? '' : sessionNames[String(r.kind)] ?? 'Session' });
  }
  if (!seen.has('')) sessions.push({ id: '', name: '' });
  sessions.sort((a, b) => compare(a.id, b.id));
  records.sort((a, b) => compare(string(a.sessionId ?? '', true), string(b.sessionId ?? '', true)));
  return { agentId: route.id, scope: 'listed', sessions, records };
}
