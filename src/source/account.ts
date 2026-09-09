import type { History } from '../model';
import { ExportError, requireThat } from '../diagnostics/errors';
import { hash, stable } from '../validate';
import type { BotInventory } from './discovery';
import { scanHistory, type HistoryTransport } from './history';
import { delay } from './http';
import { sessionInventory, type SessionInventory } from './sessions';

export interface AccountRead { bots: BotInventory; sessions: SessionInventory[]; histories: History[] }

/** Observational stability only. This is not an atomic source snapshot. */
export async function readAccount(accountId: string, discovery: { inventory(signal: AbortSignal): Promise<BotInventory> },
  transport: HistoryTransport, signal: AbortSignal, progress: (message: string) => void = () => {}, pause = delay): Promise<AccountRead> {
  const inventory = async () => {
    const bots = await discovery.inventory(signal), sessions: SessionInventory[] = [];
    requireThat(bots.agents.length > 0, 'coverage', 'Empty-account discovery has not been validated. No archive was published.');
    for (const route of bots.routes) sessions.push(await sessionInventory(transport.rpc, route, signal));
    return { bots, sessions };
  };
  const collect = async (pass: number): Promise<AccountRead> => {
    const initial = await inventory(), histories: History[] = [];
    const agents = new Map(initial.bots.agents.map(a => [a.id, a]));
    progress(`Pass ${pass}: reading ${agents.size} bots and all discovered sessions.`);
    const unverified = initial.sessions.filter(s => s.scope === 'default-only-unverified').length;
    if (unverified) progress(`Additional-session inventory unavailable for ${unverified} gateway-only box bots. Their default histories will be read; additional-session coverage remains unverified.`);
    for (const bot of initial.sessions) {
      const agent = agents.get(bot.agentId)!;
      for (const session of bot.sessions) {
        histories.push(await scanHistory(transport, { accountId, agentId: agent.id, agentName: agent.name,
          sessionId: session.id, sessionName: session.name }, initial.bots.agents, signal));
        const latest = histories.at(-1)!;
        progress(`Pass ${pass}: read conversation ${histories.length} (${latest.messages.length} text messages).`);
      }
    }
    requireThat(stable(initial) === stable(await inventory()), 'consistency', 'The bot or session inventory changed while reading history.');
    return { ...initial, histories };
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const first = await collect(1), second = await collect(2);
      requireThat(hash(stable(first)) === hash(stable(second)), 'consistency', 'The two full-account reads disagreed. Stop activity in Grok Bot and retry.');
      return second;
    } catch (error) {
      if (!(error instanceof ExportError) || error.code !== 'consistency' || attempt === 2) throw error;
      progress(`Source changed; retrying the entire account (${attempt + 2}/3).`);
      await pause(1000 * 2 ** attempt, signal);
    }
  }
  throw new ExportError('consistency', 'The account did not settle within the retry policy.');
}
