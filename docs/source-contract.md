# Source contract and limits

Grok Vault uses an undocumented Grok Bot 0.44.0 client interface. Compatibility with other versions is not guaranteed. Authentication and transport are independently implemented; no application bundle, desktop cache, credentials, or real transcript fixtures are distributed here.

## Browser authentication and discovery

PKCE sign-in opens `https://cursor.com/loginDeepControl` with a public challenge and polls `https://api2.cursor.sh/auth/poll`. The verifier and acquired credentials stay in process memory. The token is not intrinsically restricted to reads; the exporter enforces its own method allowlist.

The central service is `https://api2.cursor.sh/aiserver.v1.GrokBotService/`. Allowed methods are `GetSandBoxRunState`, non-waking `EnsureSandBox`, `ListGrokBotAgents`, `ListGrokBotAgentSessions`, `ListGrokBotTranscriptEntries`, and `PresignSandBoxStoreReads`. An absent or sleeping account box is not created or woken.

The service-issued HTTPS gateway receives its own gateway and network tokens, never the service bearer token. Only `listAgents` and `countAgents` are called. Gateway `id` and central `agentId` are canonical; the central record's `id` and `legacyAgentId` are not substitutes. Roster/count disagreement, duplicate IDs, or conflicting metadata fails discovery.

The default session ID is the empty string. A listed default is deduplicated with the implicit default; every listed additional session remains a separate conversation. Only a gateway-only box bot absent from the central roster may continue after a session-list HTTP 404, with `default-only-unverified` coverage. Other session-list errors remain fatal. Shared bots without validated owner/session access and unsupported participant shapes are rejected rather than silently skipped.

## Raw history

`ListGrokBotTranscriptEntries` accepts `agentId`, `sessionId`, `limit`, optional `generation`, and optional `beforeSeq`. It returns `generation` and descending `entries`. Each raw entry has `seq`, `updatedSeq`, `entryKind`, optional `entryId`, and inline `body`, `blobHash`, or `bodyOmitted` metadata.

The exporter preserves uint64 sequences as decimal strings, pins generation while paging, requires strict cursor progress, and reads until an empty raw page. Page size is bounded; total page and message counts are not. Every raw row must resolve to a body and become exported text or an explicit exclusion. Unknown schemas, unfinished streaming text, missing bodies, and ambiguous attribution stop publication.

Omitted bodies are re-read by exact sequence/version. Blob bodies use service-issued signed storage URLs without account authorization headers and are SHA-256 checked. Redirects are rejected. Network retries and response-size limits fail visibly rather than silently truncating an export.

## Observational coverage

Two full-account scans must match, including resolved row bodies, generation/sequences, metadata, and before/after inventories. Detected changes retry the whole account at most three times. A generation ID or equal scans do not establish an atomic snapshot; transient changes between reads can escape detection.

Notes use `observed-retained-history`. The manifest identifies every unverified additional-session inventory and records the two-scan evidence without asserting inventory completeness or a verified retention boundary. Existing archived history remains protected against source loss and rewrites.

## Validation boundaries

Synthetic tests cover large histories, multiple sessions, omitted/blob bodies, changing reads, and publication/recovery failures. A successful authenticated CLI run has been reported separately; no account-specific counts, identifiers, logs, or message content are published as evidence. Live long-history, broader participant/storage cases, absent/empty accounts, minimum-OS support, signing, and notarization still need validation.
