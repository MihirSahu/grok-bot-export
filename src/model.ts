export interface Agent { id: string; name: string; group: boolean; hidden: boolean }
export interface Conversation { accountId: string; agentId: string; agentName: string; sessionId: string; sessionName: string }
export interface Speaker { kind: 'human' | 'agent'; id: string }
export interface Peer { direction: 'from' | 'to'; id: string; name: string }
export interface Message {
  entryId: string; role: 'user' | 'assistant'; content: string; timestamp: string | null;
  sourceOrder: number; sourceSchemaVersion: 1; sourceGeneration: number;
  sourceSequence: string; sourceUpdatedSequence: string;
  sourceKind: string; sourceRole: string | null; speaker: Speaker; peer: Peer | null;
  contentHash: string;
}
export interface History {
  conversation: Conversation; messages: Message[]; rawCount: number;
  exclusions: Record<string, number>; generation: number; rawFingerprint: string;
  oldestSequence: string | null; newestSequence: string | null; maxUpdatedSequence: string | null;
  termination: 'empty-raw-page';
}
export interface VerifiedCertificate {
  contract: string;
  consistency: 'immutable-snapshot' | 'validated-change-boundary' | 'validated-quiescent-read';
  boundary: string;
  inventoryComplete: true;
  retentionBoundaryVerified: true;
}
export interface ObservedCertificate {
  contract: 'grok-bot-0.44.0/repeated-account-read-v1';
  consistency: 'matching-full-account-scans';
  boundary: string;
  inventoryComplete: false;
  retentionBoundaryVerified: false;
  fullScanCount: 2;
  sessionCoverage: { agentId: string; scope: 'listed' | 'default-only-unverified'; sessionIds: string[] }[];
}
export type Certificate = VerifiedCertificate | ObservedCertificate;
export type Coverage = 'complete-retained-history' | 'observed-retained-history';
export const coverageOf = (certificate: Certificate): Coverage => certificate.consistency === 'matching-full-account-scans' ? 'observed-retained-history' : 'complete-retained-history';
export interface Snapshot { accountId: string; agents: Agent[]; histories: History[]; certificate: Certificate }
export interface Source { snapshot(signal: AbortSignal): Promise<Snapshot>; close(): void }
export const conversationKey = (c: Pick<Conversation, 'accountId' | 'agentId' | 'sessionId'>) => JSON.stringify([c.accountId, c.agentId, c.sessionId]);
export const agentKey = (c: Pick<Conversation, 'accountId' | 'agentId'>) => JSON.stringify([c.accountId, c.agentId]);
