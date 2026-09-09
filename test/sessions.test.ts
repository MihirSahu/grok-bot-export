import { expect, test } from 'bun:test';
import { botInventory, type AgentRoute } from '../src/source/discovery';
import { HttpError } from '../src/source/http';
import { sessionInventory } from '../src/source/sessions';
import { readAccount } from '../src/source/account';
import { agent, c, paginated, row, signal } from './fixtures';

const route: AgentRoute = { id: c.agentId, gateway: true, central: false, harness: 'box' };
test('a gateway-only box 404 preserves default history and records uncertain session coverage', async () => {
  const result = await sessionInventory(async () => { throw new HttpError(404); }, route, signal());
  expect(result.scope).toBe('default-only-unverified');
  expect(result.sessions).toEqual([{ id: '', name: '' }]);
});
test('session errors cannot hide registered, server-only, temporal, or inaccessible bots', async () => {
  for (const r of [{ ...route, central: true }, { ...route, gateway: false, central: true }, { ...route, harness: 'temporal' as const }]) {
    await expect(sessionInventory(async () => { throw new HttpError(404); }, r, signal())).rejects.toThrow('404');
  }
  for (const status of [401, 403, 429, 500]) await expect(sessionInventory(async () => { throw new HttpError(status); }, route, signal())).rejects.toBeInstanceOf(HttpError);
});
test('explicit and omitted default IDs are accepted once; additional sessions stay distinct', async () => {
  const result = await sessionInventory(async () => ({ sessions: [
    { agentId: c.agentId, sessionId: 'dm', kind: 4 }, { agentId: c.agentId, kind: 1 },
  ] }), route, signal());
  expect(result.scope).toBe('listed');
  expect(result.sessions).toEqual([{ id: '', name: '' }, { id: 'dm', name: 'DM' }]);
  await expect(sessionInventory(async () => ({ sessions: [{ sessionId: '' }, {}] }), route, signal())).rejects.toThrow('Duplicate');
  await expect(sessionInventory(async () => ({ sessions: [{ agentId: 'wrong' }] }), route, signal())).rejects.toThrow('different bot');
  await expect(sessionInventory(async () => ({ sessions: [], nextPage: 'more' }), route, signal())).rejects.toThrow('Unsupported');
});
test('routing retains gateway/central membership and rejects conflicting harnesses', () => {
  expect(botInventory([{ id: c.agentId }], 1, []).routes).toEqual([route]);
  expect(botInventory([{ id: c.agentId }], 1, [{ agentId: c.agentId, harness: 'temporal' }]).routes[0]).toEqual({ ...route, central: true, harness: 'temporal' });
  expect(() => botInventory([{ id: c.agentId, harness: 'box' }], 1, [{ agentId: c.agentId, harness: 'temporal' }])).toThrow('routing');
  expect(() => botInventory([{ id: c.agentId, harness: 'future' }], 1, [])).toThrow('harness');
});

test('the observed five-bot roster pattern reads all five defaults twice and retains all four coverage gaps', async () => {
  const gateway = Array.from({ length: 5 }, (_, i) => ({ id: `bot-${i}`, name: `Bot ${i}` }));
  const bots = botInventory(gateway, 5, [{ agentId: 'bot-0', name: 'Bot 0', harness: 'box' }]);
  const heads: string[] = [];
  const observed = await readAccount(c.accountId, { inventory: async () => bots }, {
    blob: async () => new Uint8Array(), rpc: async (method, p, s) => {
      if (method === 'ListGrokBotAgentSessions') {
        if (p.agentId === 'bot-0') return { sessions: [] };
        throw new HttpError(404);
      }
      if (!('beforeSeq' in p)) heads.push(String(p.agentId));
      return paginated([row(0)]).rpc(method, p, s);
    },
  }, signal());
  expect(heads).toEqual([...gateway, ...gateway].map(b => b.id));
  expect(observed.histories).toHaveLength(5);
  expect(observed.sessions.filter(s => s.scope === 'default-only-unverified')).toHaveLength(4);
});

test('full-account reads paginate each additional session beyond 500 rows and preserve identical entry IDs in different sessions', async () => {
  const bots = { agents: [agent], routes: [{ ...route, central: true }] };
  const rows = Array.from({ length: 601 }, (_, i) => row(i));
  const page = paginated(rows), heads: string[] = [];
  const observed = await readAccount(c.accountId, { inventory: async () => bots }, {
    ...page, rpc: async (method, payload, s) => {
      if (method === 'ListGrokBotAgentSessions') return { sessions: [{ sessionId: 'extra', kind: 4 }] };
      if (!('beforeSeq' in payload)) heads.push(String(payload.sessionId));
      return page.rpc(method, payload, s);
    },
  }, signal());
  expect(heads).toEqual(['', 'extra', '', 'extra']);
  expect(observed.histories.map(h => h.messages.length)).toEqual([601, 601]);
});

test('a change to an earlier bot while reading a later bot retries the whole account', async () => {
  const bots = { agents: [agent, { ...agent, id: 'z' }], routes: [route, { ...route, id: 'z' }] };
  let changed = false, firstBotHeads = 0;
  const observed = await readAccount(c.accountId, { inventory: async () => bots }, {
    blob: async () => new Uint8Array(), rpc: async (method, p, s) => {
      if (method === 'ListGrokBotAgentSessions') throw new HttpError(404);
      if (p.agentId === 'z') changed = true;
      if (p.agentId === c.agentId && !('beforeSeq' in p)) firstBotHeads++;
      return paginated([row(0, { content: changed ? 'new' : 'old' })]).rpc(method, p, s);
    },
  }, signal(), () => {}, async () => {});
  expect(firstBotHeads).toBe(4);
  expect(observed.histories[0]!.messages[0]!.content).toBe('new');
});

test('changing additional-session discovery exhausts bounded retries without returning an account', async () => {
  const bots = { agents: [agent], routes: [route] }; let calls = 0;
  await expect(readAccount(c.accountId, { inventory: async () => bots }, {
    blob: async () => new Uint8Array(), rpc: async method => {
      if (method === 'ListGrokBotAgentSessions') return { sessions: [{ sessionId: `session-${++calls}` }] };
      return { entries: [], generation: 1 };
    },
  }, signal(), () => {}, async () => {})).rejects.toThrow('inventory changed');
  expect(calls).toBe(6);
});
