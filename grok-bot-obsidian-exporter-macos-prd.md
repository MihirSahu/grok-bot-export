# Product Requirements Document: Grok Vault for macOS

## 1. Document status

- **Status:** Development implementation supports browser-authenticated export after two matching full-account scans, with unverified additional-session inventories explicitly reported. This observational policy does not assert guaranteed completeness.
- **Implementation:** The development CLI reads all discovered conversations, validates two full-account scans, and publishes notes with `coverage: observed-retained-history`. See [implementation status](docs/implementation-status.md) for tests, live evidence, and remaining release work.
- **Working product name:** Grok Vault
- **Product type:** Local command-line utility
- **Runtime:** Bun 1.4.2, revision `744846f84`, with TypeScript
- **Target platform:** Apple Silicon macOS 13.0 or later. Research checks ran on macOS 26.6.2; a macOS 13 release test is mandatory before advertising that minimum as tested.
- **Source application:** Grok Bot desktop app for macOS
- **Destination:** A user-selected Obsidian vault or local directory

## 2. Product summary

Grok Vault exports **all retained user-visible conversation text** for the authenticated user's accessible Grok Bot agents and their conversations into Obsidian-compatible Markdown. It retrieves every raw page through an empty terminal page, including messages older than any desktop cache or initially loaded UI page. The service does not supply an atomic snapshot or a verified retention boundary; exported metadata records that limitation.

The command remains:

```bash
grok-vault export "/Users/me/Documents/Obsidian/My Vault"
```

The destination is the only product argument. Authenticate through browser sign-in, then discover bots through the account's cloud gateway and server roster and retrieve their history. The product must not require Grok Bot to be installed or running locally, or read its desktop cache, account files, or stored credentials. Formatting and archive writing run locally. No transcript is uploaded to an analytics, AI, or exporter-hosted service.

The MVP assumes the user has **one Grok Bot account**. Each output root archives that account's discovered agent/session inventory, including supported team/group conversations, and records any permitted inventory uncertainty. There is no account selector, account-switching workflow, or cross-account merge. Keep `account_id` in archive metadata for provenance and consistency checks.

The desktop `.blob` cache is **not an export source or an offline fallback**. Results must never be presented as guaranteed complete history. A successful observed export requires every discovered history to be read and classified in two matching full-account scans. The narrowly permitted session-list uncertainty in section 10.2 is reported in the CLI and manifest. Other read failures stop before publishing new notes.

“All messages” means retained conversation text, including correctly attributed human/agent participants, across every accessible agent and session. It does not promise recovery of permanently deleted server data. Widgets, attachments, private reasoning, and internal tool records remain outside the original text-export scope; their exclusions are counted explicitly. An unclassified row must fail rather than be silently omitted.

## 3. Source contract

The desktop cache holds a bounded suffix and is not an export source. The product instead uses browser authentication, gateway and central-service discovery, and raw transcript pagination. The inspected client contract is Grok Bot 0.44.0; it is an undocumented service interface and may change.

- Browser PKCE sign-in obtains credentials in memory. `GetSandBoxRunState` and `EnsureSandBox({wake: false})` connect only to an already-running account box.
- Gateway `listAgents` / `countAgents` and central `ListGrokBotAgents` are complementary inventories. Join gateway `id` with central `agentId`, never the central database record ID.
- `ListGrokBotAgentSessions` lists additional sessions when available. A gateway-only box bot can have readable default history while that method returns HTTP 404. This narrowly permitted uncertainty must be disclosed.
- `ListGrokBotTranscriptEntries` accepts agent/session IDs, optional generation and `beforeSeq`, and a page limit. Continue until an empty raw page, with no total page or message cap.
- Raw rows include sequence/update sequence, kind, optional entry ID, and inline/omitted/blob-backed bodies. Every returned row must be resolved and classified; the app's filtered display results are not an authoritative export source.

See [source contract and limitations](docs/source-contract.md) for protocol details. Account-specific research reports, extracted application code, identities, usage counts, and transcript data are not part of the public repository.

## 4. Problem statement

The user needs a complete portable archive of Grok Bot conversations, including old messages. Copying a bounded local cache does not solve this problem even when every cached message is exported correctly. The product must use all validated discovery routes, retrieve every returned history page, and account for every returned row. It must explicitly distinguish observed coverage from unverified additional-session or atomic-snapshot coverage.

## 5. Goals

- Export all retained supported conversation text for every accessible agent and session, including hidden/uncached agents and older pages.
- Preserve source message identity, attribution, order, and text bytes.
- Detect incomplete discovery, pagination, unresolved bodies, unsupported shapes, and unstable reads before publishing.
- Produce one-command, deterministic, duplicate-free Obsidian output.
- Preserve existing archives and unrelated files; recover interrupted publication safely.
- Use authorized read-only service operations without changing messages, read/unread flags, agent settings, or source data.
- Keep transcript processing and output local, apart from authorized inbound retrieval from Grok Bot's service/storage.

## 6. Success criteria

- A first export includes complete retained history, even when it spans thousands of entries and the desktop cache contains only 200 or fewer.
- Every discovered agent/session is read. Inaccessible histories and unsupported conversations prevent status `0`. A gateway-only box bot whose session list returns HTTP 404 has its default history read and additional-session coverage explicitly marked unverified.
- Every returned raw row is accounted for as exported text or a specific out-of-scope category. Missing bodies and decoding failures prevent success.
- Every conversation reaches an empty raw-service page; a short display page, empty decoded page, or cache exhaustion cannot end pagination. This observed termination is recorded without claiming a verified service retention boundary.
- Repeated exports against unchanged authoritative data leave Markdown bytes and mtimes unchanged.
- New messages are added once; ambiguous edits/deletions do not overwrite prior archives.
- No new notes are published on discovery, authentication, schema, coverage, or consistency failure. Previously committed journal recovery is separately reported as defined in section 11.4.
- Existing unrelated files are preserved under the documented external-writer exclusion; newly occupied target paths use atomic no-clobber publication.

## 7. Non-goals

- Windows/Linux, a GUI exporter, an Obsidian plugin, watch mode, scheduling, or AI transformation.
- Exporting Grok on X or grok.com; this product targets Grok Bot desktop-account history.
- Private reasoning, hidden prompts, tool-call internals/results, widgets, or attachment payloads. Unsupported potentially visible text is an error, not an implicit exclusion.
- Recovering messages the source has permanently deleted or made inaccessible. Report known unavailable history; never describe a partial accessible subset as all requested messages.
- Sending prompts, changing source read/unread state, creating/deleting agents, or modifying Grok Bot data.
- Extracting/decrypting the desktop app's credentials, cookies, Keychain entries, or gateway descriptors; requesting pasted tokens or passwords; copying third-party tool authentication stores.
- A configuration file, persistent exporter database, or cached-token file. Temporary staged history and recovery journals are permitted with restrictive permissions and explicit cleanup rules.
- A cache-only, selected-agent, recent-only, force, or silent partial-success mode. The default policy reads all discoverable history and explicitly reports the approved session-inventory and snapshot limitations.
- Multiple-account discovery, account switching, or combining accounts in one archive.

## 8. User experience

### 8.1 Command and authentication

```bash
grok-vault export <vault-path>
```

`--help` and `--version` are standard CLI exceptions. The command performs interactive browser authentication, with the user completing sign-in/consent at the verified provider. The research probe validated PKCE login through `cursor.com/loginDeepControl`, polling `api2.cursor.sh/auth/poll`, and using the resulting token for read-only Grok Bot RPCs. Keep the verifier and session credentials in memory and discard them on exit. Never extract existing credentials. This login does not establish that the token is technically restricted to read-only permissions; the exporter must enforce its own explicit read-method allowlist. Production expiry/cancellation/error handling remains a release requirement.

### 8.2 Automatic workflow

1. Validate the destination, obtain the archive lock, and recover any committed write transaction.
2. Authenticate the user's single account and establish its identity and authorized scope. Existing archive metadata must agree with that identity before a new transaction can be published.
3. Enumerate all accessible agents and sessions, including hidden/uncached conversations and supported groups.
4. Retrieve every page and resolve every row body while tracking completeness and generation/sequence information.
5. Require two matching full-account scans, including before/after bot and session inventories, and construct deterministic daily notes in the archive timezone.
6. Preflight and atomically publish using the recovery protocol.
7. Report exported conversations/messages, explicit exclusions, created/updated/unchanged notes, and the number of unverified session inventories. Refer to `_export.md` for the observational evidence and absence of an atomic snapshot guarantee.

### 8.3 Completion and failure

Status `0` means all discovered histories were retrieved through empty raw pages in two matching full-account scans and their observed export was published. It does not guarantee that no undiscoverable sessions exist or that the source was an atomic snapshot. The CLI and manifest report additional-session inventories that could not be verified. An incomplete page traversal, inaccessible discovered conversation, unresolved body, unsupported attribution, unstable history, or authentication failure returns `1` and publishes no new transaction. Never fall back to the desktop cache.

A still-streaming row at the captured boundary is incomplete: retry within a bounded policy, then fail with an actionable message if it cannot settle. Do not call a deferred-message export complete.

Errors distinguish sign-in needed, source unavailable, incomplete history, unsupported schema, and destination/manual-edit conflicts. Never print tokens, signed URLs, raw response bodies, or message content.

## 9. Output specification

### 9.1 Fixed directory structure

- The output root is always `<vault-path>/Grok Bot`.
- Every exported agent receives one immediate child directory. Default-session notes remain directly inside it. Additional sessions use `Sessions/<safe-session-name — stable-id>/YYYY-MM-DD.md`; reserve `Sessions` from conflicting generated names. Session directory identities follow the same safe-name and reuse rules as agents.
- Every dated transcript file is named `YYYY-MM-DD.md`.
- Messages without a usable timestamp are written to `_undated.md` in source order.
- `_undated.md` uses `date: null` in frontmatter and `## Undated — <speaker>` headings.
- Filesystem modification times must never be used as message timestamps.
- An authoritatively empty conversation is recorded in the completion inventory; never invent a transcript message. Publish a versioned, hash-verified `_export.md` completion manifest under the root identifying the single account and listing every agent/session, raw-row/text/exclusion counts, generation and sequence boundaries, and observed completion time. Replace it through the same journal as notes. Preserve its prior bytes on a byte-identical logical snapshot so repeated exports remain deterministic.

### 9.2 Agent directory names

- Prefer the roster display name. Reserve `_export.md`, `.grok-vault.lock`, and the `.grok-vault-` artifact prefix, including their normalized/case-folded equivalents; agent directory names must never occupy that namespace.
- Replace `/`, `\`, `:`, NUL, control characters, empty names, `.` and `..` with safe equivalents.
- Normalize names to NFC, trim surrounding whitespace, and use a conservative NFD-plus-case-folded collision key even when the destination volume is case-sensitive.
- Keep each path component within 255 UTF-8 bytes. Truncate at a grapheme boundary and append a stable identifier when necessary.
- If two agents have the same safe display name, append a short stable identifier.
- If no display name is available, use `Unnamed Agent — <short-id>`.
- For a reserved display name, allocate `Agent — <safe-name> — <short-id>`, then repeat normalization, length, reservation, and collision checks on the final component. Appending a suffix alone cannot escape the reserved `.grok-vault-` prefix.
- Use `(account ID, agent ID, session ID)` as conversation identity and `(account ID, agent ID)` for the agent directory. The agent ID is the canonical ID defined in section 10.2, never the central server record ID. The default session has the explicit empty-string ID. Never merge different sessions solely because entry IDs or names match.
- On later exports, scan existing generated frontmatter to find the directory already associated with that identity. Reuse that directory even if the agent's display name has changed. This prevents duplicate folders without requiring external state.
- If one identity appears in multiple directories or one session directory contains generated files for multiple conversation identities, report a conflict. If the preferred path is occupied by an unrelated file or a directory containing only unrelated files, allocate a stable suffixed directory without modifying those files. Extend the suffix deterministically until collision-free; never overwrite on a short-ID collision. Apply reservation and file-versus-directory collision checks to reused paths too.
- When an agent is renamed, retain its existing directory but update the generated frontmatter and assistant headings in every verified generated note to the current roster name.
- Never construct or follow an output path that resolves outside the selected destination.

### 9.3 Date grouping and archive timezone

- On the first export into an empty output, capture the Mac's current IANA timezone identifier as the archive timezone.
- Record `archive_timezone` in every generated note and `_export.md`. All generated artifacts in one output root must agree on this value.
- On later exports, use the recorded archive timezone even if the Mac's system timezone has changed. A system timezone change must never move an already exported message between files.
- The exporter has no timezone setting or timezone flag.
- Convert each newly observed supported timestamp to a local date and time using the archive timezone.
- Preserve archive order when timestamps are equal, missing, or move backward during a daylight-saving transition.
- Reuse `_export.md`'s timezone even when all conversations are empty. Establish a new archive timezone only when neither valid notes nor a valid completion manifest remains; malformed managed metadata is a conflict, not a new archive.

### 9.4 Markdown format

Each daily note uses this structure. Hash strings are illustrative placeholders; offsets and lengths refer to the exact example body. Production hashes must be full SHA-256 hex values prefixed with `sha256:`.

```markdown
---
source: "grok-bot"
generated_by: "grok-vault"
format_version: 2
account_id: "account-example"
agent_id: "agent-example"
session_id: ""
coverage: "observed-retained-history"
agent: "Researcher"
date: "2026-09-07"
archive_timezone: "America/Chicago"
entry_index:
  - id: "t0u"
    role: "user"
    source_kind: "message"
    source_role: "user"
    speaker: {kind: "human", id: "self"}
    peer: null
    source_generation: 1
    source_sequence: "1"
    source_updated_sequence: "1"
    source_timestamp: "2026-09-07T19:03:00.000Z"
    archive_order: 0
    content_offset: 18
    content_bytes: 34
    content_hash: "sha256:example-user"
  - id: "t0a"
    role: "assistant"
    source_kind: "send-message"
    source_role: null
    speaker: {kind: "agent", id: "agent-example"}
    peer: null
    source_generation: 1
    source_sequence: "2"
    source_updated_sequence: "2"
    source_timestamp: "2026-09-07T19:05:00.000Z"
    archive_order: 1
    content_offset: 79
    content_bytes: 21
    content_hash: "sha256:example-assistant"
render_hash: "sha256:example-file"
---

## 14:03 — You

Research the competing approaches.

## 14:05 — Researcher

Here is what I found.
```

Requirements:

- Preserve message text byte-for-byte after decoding the source string. Do not repair or rewrite Markdown. Typical self-contained paragraphs, lists, tables, and fenced code should render readably, but identical rendering to separate chat messages is not guaranteed: reference links and footnotes share a document namespace, relative links resolve from the note, and unclosed fences or HTML can affect subsequent messages. Exact text preservation takes precedence over rendering isolation. Document these limits and test repeated reference labels, footnotes, and unclosed fences.
- Label direct human messages `You` and ordinary assistant text with the current agent display name. A `fromAgent` row is `From <peer name>`; a `toAgent` row is `<current agent> → <peer name>`. Peer names resolve by ID in the same-account roster when available, otherwise from validated row metadata or a stable unnamed fallback. Never label an incoming peer row `You` solely because its source role is `user`. Escape heading names as single-line Markdown text without changing message bodies.
- Render local timestamps using 24-hour time.
- Quote or escape frontmatter values safely.
- Store an authoritative `entry_index` in each note. For every entry it records the source ID, normalized role, `source_kind`, `source_role` (or `null`), `speaker` (`kind: human|agent`, `id: self|<source-participant-id>`), `peer` (`null` or `{direction: from|to, id, name}`), source timestamp or `null`, server generation, source sequence and update-sequence (lossless decimal strings), stable archive order, SHA-256 content hash, and the UTF-8 byte offset and length of the unmodified message content. `self` is a literal identifier only for the direct human speaker; other participants use their validated source identity, including group authors and other humans. The note body begins with the first byte after the blank line following the closing frontmatter delimiter; offsets are measured from that byte.
- Treat the entry index, not delimiter-like text in a message body, as authoritative for duplicate detection, content extraction, and reconciliation. Message content may contain text resembling exporter metadata without affecting parsing.
- Calculate `render_hash` over the exact UTF-8 bytes of the complete generated file after removing exactly the one canonical `render_hash` key-value line and its terminating LF. This covers all other managed frontmatter, the entry index, headings, message content, and line endings without requiring an external database.
- Calculate each `content_hash` over the exact UTF-8 bytes represented by that entry's `content_offset` and `content_bytes` slice.
- Reject unpaired UTF-16 surrogates rather than silently replacing them during UTF-8 encoding. Render deterministically with UTF-8 and use LF for exporter-generated structural line endings. Do not normalize line endings inside message content. Reject duplicate frontmatter keys and malformed managed metadata.
- Do not add tags, backlinks, summaries, topics, or Obsidian wikilinks.

### 9.5 Completion manifest

`Grok Bot/_export.md` is an exporter-owned Markdown artifact with `source: grok-bot`, `generated_by: grok-vault`, `format_version: 2`, `document_type: export-manifest`, the single `account_id` even when the roster is empty, `archive_timezone`, `coverage: observed-retained-history`, a completion timestamp, and a sorted conversation inventory. Each inventory record contains account/agent/session IDs, the raw/exported/excluded counts, generation/sequence/update boundaries, and observed empty-raw-page termination evidence. The `certificate` field records `matching-full-account-scans`, two completed scans, a content fingerprint, and per-bot session IDs with `listed` or `default-only-unverified` scope. Both `inventoryComplete` and `retentionBoundaryVerified` remain `false`; this is evidence of observation, not an atomic completeness certificate. All inventory records and notes must agree with the manifest's account ID. It contains no tokens, signed URLs, or message bodies. Its whole-file hash uses the same canonical `render_hash` rule as notes; malformed or edited metadata stops preflight. Use the manual recovery procedure in section 11.2 for a damaged root manifest; moving an agent directory cannot resolve that conflict.

Stage this manifest in the same transaction as its notes and include it in recovery validation. Validate that manifest counts/identities agree with all intended conversation notes. Publish the manifest after its notes; consumers must treat a pending transaction as in-progress even if an older manifest exists. Preserve its completion timestamp on an unchanged logical snapshot so a no-op export changes no file. Format-1 cache archives cannot be relabeled complete; detect them and require an explicit, backed-up migration with full-source reconciliation.

## 10. Full-history discovery and retrieval contract

### 10.1 Authoritative adapter

Use the verified browser-authenticated cloud gateway for box-bot discovery and the server service for its roster and raw history. The standalone client obtains fresh connection details through the authenticated broker; it does not attach to Electron IPC or extract local gateway descriptors. Enforce a narrow allowlist for connection establishment and read operations; never invoke agent/message mutation methods.

The final adapter must perform no local Grok Bot data reads. Earlier cache comparisons were research only and do not define production coverage.

### 10.1.1 Browser-only connection

1. Complete PKCE browser sign-in and retain the service token only in memory.
2. Read `GetSandBoxRunState`. The validated path requires an already-running account box; otherwise report source unavailability. Do not silently create, wake, recreate, or upgrade a box.
3. Call `EnsureSandBox({wake: false})` to obtain the gateway URL, gateway token, and network token. This is an explicit connection-broker operation, not an ordinary history read. The no-wake flag is present in the installed protocol; the live check ran only against an already-running box. Sleeping/absent-box behavior remains untested.
4. Validate the returned HTTPS gateway endpoint. For gateway requests, use its gateway bearer token and `x-anyrun-network-token`; keep the service bearer token confined to the service origin. Reject redirects that could disclose credentials.
5. Keep all tokens/connection descriptors only in memory and discard them when the process exits. No local desktop installation or local credential cache is needed.

### 10.2 Discovery

- Enumerate the authenticated account's full accessible agent roster, including hidden agents and supported team/group conversations. Do not copy the desktop helper's `harness === temporal` filter or limit discovery to recently mounted agents.
- Read gateway `/api/listAgents` and `/api/countAgents`, validate unique IDs, and require matching list/count results under a stable inventory. Preserve hidden/group bots rather than filtering them. Verify empty-account behavior, including the installed `allowEmptyRoster` argument, before release.
- Also read `ListGrokBotAgents({includeTeamAgents: true})` and union by canonical agent identity with the gateway results. Server-only agents must not disappear because the gateway lacks them; validate routing for each supported type. Conflicting identity mappings or metadata must fail explicitly.
- The canonical agent ID is the gateway `/api/listAgents` row's `id` or the central `ListGrokBotAgents` row's `agentId`. The shared bot was verified by exact equality of those fields. Treat IDs as opaque, case-sensitive values; merge rows with that same canonical ID once and retain gateway-only and server-only IDs. Use this canonical value for history RPC `agentId`, note/manifest `agent_id`, and directory identity.
- The central row's separate `id` identifies its server record; `legacyAgentId` is not a validated substitute for `agentId`. Neither field may be used as the join key or history ID. Never join by display name. Missing/invalid canonical IDs, duplicate IDs within a roster, or conflicting mappings must fail discovery rather than drop a bot or invent a fallback. Any future legacy mapping requires separate validation before support is claimed.
- Enumerate every session per agent. Distinguish default and nondefault sessions by stable IDs; a failed session-list operation is not an empty session list. Validate whether the service includes the default session or requires adding it explicitly.
- Live evidence shows that an empty session list can coexist with a nonempty default history, and session-list HTTP 404 can coexist with readable default history. Always account for the explicit empty-string default-session route, whether omitted or included in the list. For a gateway-only box bot absent from the central roster, HTTP 404 permits reading the default history with `default-only-unverified` session coverage. Never treat this as an authoritative empty list. For registered, server-only, or temporal bots, session-list HTTP 404 remains fatal; all other session-list errors remain fatal. Record and display every permitted uncertainty.
- Recheck the agent/session inventory before committing. A changing inventory causes retry or failure, never silent omission.
- If legacy/cloud-box agents require a different authoritative route, validate it as part of this adapter or fail clearly. No known agent type may be silently skipped to obtain a green export.

### 10.3 Pagination and raw-row accounting

- Candidate read RPC: `aiserver.v1.GrokBotService.ListGrokBotTranscriptEntries` with `agentId`, `sessionId`, `generation`, `beforeSeq`, and `limit` as applicable. The installed coordinator caps requested display pages at 500 and uses one-row lookahead; that is a **page size**, not a total-history cap.
- Parse sequence and update-sequence values as unsigned 64-bit integers, never floating-point JavaScript numbers. Preserve them as decimal strings in metadata.
- Establish the returned generation, retrieve pages toward older sequence values, and require strict cursor progress. Repeated/non-decreasing cursors, inconsistent duplicate rows, unexpected generation changes, or ambiguous boundaries fail.
- Determine termination from the validated raw-service contract. Do not infer exhaustion from the number of decoded visible messages. A page containing only widgets or unresolved content can still precede older messages.
- Deduplicate pagination overlap only by conversation identity plus sequence/entry ID, verifying identical version/content. Distinct IDs with identical text remain distinct messages. Sequence gaps alone are not evidence of loss: deletions and nontext rows may occupy gaps; completeness requires authoritative page coverage.
- Do not impose a 200/500-entry or maximum-page truncation. A resource/time limit may stop the invocation with failure, never report a partial full-history export.

### 10.4 Body resolution and normalization

- Every raw row must have a verified inline body or a resolved body reference before it can be classified. Retrieve `blobHash` content through authorized `PresignSandBoxStoreReads` and the returned HTTPS storage URL; resolve `bodyOmitted` using the verified targeted re-read behavior. Missing/unreadable bodies fail completeness. Do not expose signed URLs or forward account authorization headers to storage URLs.
- Decode UTF-8/JSON strictly. Match row metadata to the decoded entry ID/kind, validate supported shapes, and reject undecodable rows. Unlike the app's display helper, never log-and-drop bad rows.
- Installed code, local evidence, and live raw responses support `kind: message` with string `content`, and `kind: send-message` with `message.type: text` and string `message.content`. Every observed raw row's supplied entry ID/kind matched its decoded body. Broader schema and participant coverage still require validation.
- Direct messages use source role and participant metadata; typed text replies use their validated author/current-agent identity. Incoming/outgoing peer rows, group authors, other humans, and session-specific speakers require explicit validated attribution. Never label every `role: user` row `You`; never reject a known requested conversation merely to claim the remaining subset is complete.
- Use `timestampMs` for candidate schema message time; verify positive integer milliseconds. Missing time is undated; malformed present time fails. Never synthesize message time from file/roster/page metadata. Preserve exact decoded text, including empty strings, after rejecting invalid UTF-16 surrogates.
- Candidate completion fields are `isStreaming` on direct messages and `streaming` on typed replies. All messages through the captured boundary must settle; unresolved streaming prevents successful publication.
- Explicitly classify known nontext kinds/types and count exclusions. The installed display validator expressly rejects `spend-initiation`; account for those records as exclusions rather than decoder losses. Attachments, widgets, approvals, notices/events, feedback, and tool records do not become conversation text simply because they contain strings. Unknown potentially visible shapes fail until classified.

### 10.5 Observational consistency and coverage evidence

The user approved an observational export policy after the service's atomic-snapshot and session-enumeration limits were established. Read the entire account twice. Each scan enumerates bots and sessions before reading every history page, then rechecks the inventory afterwards. Compare the complete scan results, including generation, sequences, update sequences, resolved row bodies (including exclusions), conversation metadata, and discovery provenance. Reordered session-list rows are normalized by ID. On a detected consistency change, retry the entire account at most three times with bounded delay; never combine different attempts.

Two equal full scans establish observed stability, not a point-in-time snapshot. A generation identifier alone is insufficient, and transient changes between reads can go undetected. Do not describe this protocol as an immutable snapshot, a validated change boundary, or a verified quiescent read. Future stronger claims require independent service validation.

Record the account's discovered agent/session inventory, row/text/exclusion counts, generation and sequence/update boundaries, empty-raw-page termination, and per-bot session-list scope in `_export.md`. Require `raw rows = exported text + classified exclusions`, with no unresolved rows. New notes and the manifest use `coverage: observed-retained-history`. The historical `certificate` metadata key carries `consistency: matching-full-account-scans`, `fullScanCount: 2`, a fingerprint in `boundary`, and `sessionCoverage`; `inventoryComplete` and `retentionBoundaryVerified` are both false. Cross-check the recorded session IDs against the conversation inventory and require note coverage to agree with its manifest.

Display every `default-only-unverified` bot in the readable manifest body and report the count in CLI output. Even when all session lists succeed, report that an atomic source snapshot and service retention boundary are not verified. Permanently deleted or permission-revoked history cannot be reconstructed. Existing archive history must still be preserved and reconciled under section 11.

## 11. Reconciliation and file safety

Every invocation performs a complete one-shot export. There is no separate synchronization mode and no persistent state database. Verified note indexes and `_export.md` form the archive's durable reconciliation metadata; the completion manifest is not a substitute for fresh authoritative retrieval. A temporary, fully staged transaction journal is additionally required to recover interrupted publication; it is removed after successful completion.

### 11.1 Generated-file ownership

- Ownership is determined per file, never by directory alone. `_export.md` has the separate completion-manifest schema in section 9.5; do not attempt to validate it as a conversation note.
- A conversation note is exporter-owned only when its frontmatter contains the expected `source` and `generated_by` values, a supported `format_version`, an account ID, an agent ID, a session ID, an agent name, a date or `null`, the archive timezone, a valid entry index including attribution fields, and a valid `render_hash` covering the complete generated file except for the hash field itself.
- If a file claims `generated_by: grok-vault` but has missing, malformed, duplicate, unsupported, or hash-invalid managed metadata, treat it as a conflict. Do not silently reclassify it as unmarked.
- Never overwrite or delete an unmarked file.
- Preserve unrelated files and directories anywhere beneath `Grok Bot`.

### 11.2 Manual edits

Before replacing an existing generated file:

1. Recompute the hash of the complete generated file with its `render_hash` field omitted.
2. Compare that value with its stored `render_hash`.
3. For a conversation note, validate every entry-index offset, length, content hash, source ID, and archive-order value against the body. For `_export.md`, validate the completion-manifest schema and inventory instead.
4. If any check differs or fails, treat the file as manually edited or corrupted and stop the entire invocation before overwriting anything.

The MVP has no force or conflict-resolution flag. These manual recovery paths apply to both conversation notes and the root `_export.md` manifest:

1. Prefer restoring the exact original generated bytes from a trusted backup. Do not recompute hashes to bless edited content.
2. If exact restoration is unavailable and no committed transaction remains pending, stop all exporters and external writers, verify a backup of the entire `Grok Bot` output root, and move that root intact outside the export destination. This retires the archive with its notes, manifest, lock file, and any residual recovery artifacts together. Rerun the command against the original vault path to create a fresh output root and retrieve complete authoritative retained history for the single account. The fresh archive establishes its timezone using section 9.3. Older archive-only data deleted by the source, manual changes, and unrelated files remain in the preserved old root/backup and are not automatically reimported. Never automatically perform this reset.

Do not recommend deleting or renaming one generated file, or moving only an agent directory: those operations can leave gaps or disagree with the root completion inventory. If a committed transaction is pending, section 11.4 recovery must finish at its original canonical root before any reset. Preserve the journal and every staged payload; never delete or move them to bypass a recovery conflict. If a modified target blocks replay, restore its exact expected bytes from a trusted backup and retry; if unavailable, stop for manual recovery rather than discard the transaction. Recovery only accepts the validated old or intended new state described in section 11.4.

### 11.3 Reconcile complete snapshots

- Reconcile only after full-history discovery, retrieval, body resolution, and consistency verification succeed.
- Match messages by account, agent, session, and stable entry identity. Preserve complete source order per conversation, independent of timestamp grouping.
- Add newly observed messages once. Already archived entries must retain content, role, attribution identity, and valid timestamps; a previously absent timestamp may become known and migrate out of `_undated.md` through the journal.
- A missing historical prefix is **not recognized cache truncation** in this design. Missing agents/sessions/messages, source rewrites, conflicting generations, and changed historical order stop preflight; preserve prior notes and explain the discrepancy. Do not silently overwrite or delete archived history.
- Retain empty `_undated.md` as metadata-only output after a timestamp migration. Never delete unrelated files.
- Manual recovery follows section 11.2: exact-byte restoration or, after pending recovery finishes, a backed-up retirement of the entire output root. Fresh export must still retrieve full authoritative retained history; it cannot use a cache-only reset.

### 11.4 Preflight and safe replacement

Every invocation obtains an exclusive, OS-released advisory lock on `<vault-path>/Grok Bot/.grok-vault.lock` before scanning output and retains it until completion. Use `flock(LOCK_EX | LOCK_NB)` through `bun:ffi` against `/usr/lib/libSystem.B.dylib`; never infer lock ownership from a PID file. Create a missing lock file exclusively as an empty regular file with mode `0600`; accept an existing lock path only if it is an empty regular file with one hard link. Never write content to or unlink the lock file. Keep its inode in place across runs, reject symlinks/nonregular lock paths, and fail clearly if another exporter holds it. Fixed reserved paths with unexpected content are conflicts and must be preserved. This coordinates Grok Vault processes; external editors and sync clients must leave managed output and transaction files unchanged during export. The product does not claim atomic compare-and-swap against uncooperative external writers.

The manual whole-root retirement in section 11.2 is the sole exception to keeping the lock at its original path: all exporters must be stopped, no committed transaction may remain pending, and the old root moves intact with its lock preserved. A subsequent export creates a distinct new archive and lock; never replace a lock beneath a running exporter.

Under that lock, recover any pending transaction **before** normal archive validation or reading a new source snapshot:

1. Reserve `.grok-vault-transaction` beneath the output root. Its versioned manifest identifies the canonical output root, relative target paths, expected old whole-file hashes (or absence), intended new hashes, the expected identity/hash inventory of all unchanged managed notes, and the immutable staged new bytes for every changed note. All target paths must be unique under the same normalization/collision rules as generated names. Reject malformed manifests, unsafe paths, invalid hashes, symlinks, and unrecognized content; never treat an arbitrary folder as safe to delete.
2. Validate the unchanged managed-note inventory as well as every transaction target. Unexpected added, missing, or changed managed notes and unmarked files occupying transaction targets stop recovery; unrelated paths remain untouched. Every changed target must match either its expected old bytes/absence or its intended new bytes. Validate staged content and the complete planned final archive, including per-conversation unique IDs and contiguous archive order, completion inventory, timezone consistency, and ownership, before resuming. If any target differs from both states, stop and preserve all journal data for recovery. Never infer a partially migrated archive solely from the current notes.
3. Publish remaining old-state targets from the durable staged bytes; new-state targets are already complete and remain untouched. Source availability or subsequent source truncation does not affect replay. An undated-to-dated move therefore recovers even if an interruption left duplicates or a temporary gap among visible notes.
4. After all targets match their new hashes, flush the output directories, atomically rename the journal without replacement to `.grok-vault-done-<transaction-uuid>`, flush the root, and delete only verified exporter-created cleanup contents. On startup, finish interrupted cleanup without replaying a completed transaction. Keep staged payloads until the completion rename; publication must not consume the only staged copy.

If recovery publishes notes, report that separately. A later source/preflight failure in that invocation still returns status `1`; the zero-note-change guarantee applies to the new export transaction, not to completion of an already committed recovery transaction.

For a new export, preflight must:

1. Obtain two matching full-account reads and validate their observed coverage inventory under section 10.5.
2. Validate and normalize supported entries; validate all existing managed notes, resolve identities, reconcile the archive, and render the complete intended result.
3. Check containment, symlinks, conflicts, permissions, file identity and content hashes. Create all staged payloads with exclusive creation and restrictive permissions; flush them, the manifest, and all newly created staging directories before committing any note. Record intended new agent directories in the manifest; create and flush those directories during replay/publication so a recovered transaction does not depend on undurable directory creation. Staging errors change no generated note.
4. Publish the complete staging directory as `.grok-vault-transaction` atomically and without replacing an existing path, then flush the output root. This durable publication is the transaction commit decision. Incomplete staging directories use `.grok-vault-stage-<uuid>`; they are never replayed. Stage directories, completed-cleanup directories, and `.grok-vault-note-<uuid>.tmp` siblings are inert during archive scans. Delete their contents only when exporter provenance can be validated; otherwise preserve the residue and warn. An interrupted staging/cleanup write must not become a malformed generated-note conflict. Never treat inert artifacts as source archives or adopt a stage directory merely because its filename matches.

For each note publication, leave byte-identical output untouched, create a fresh temporary sibling from the retained staged payload, flush it, and recheck expected target identity and hash. New target names must use `renamex_np(..., RENAME_EXCL)` through the same native binding; an existence check followed by ordinary rename is insufficient. Existing verified targets are replaced atomically only under the exporter lock and the external-writer exclusion above. Flush the containing directory after publication. Stop on detected external changes and retain the journal. Temporary and journal files use mode `0600`; new managed directories use `0700`; do not change permissions on unrelated existing directories.

Atomicity is per note. Readers may observe mixed generations during publication, but every note is complete. A process interruption is recoverable from the durable journal without relying on a fresh source snapshot. Do not delete a committed journal on failure. If the runtime cannot expose the required locking and atomic no-replace primitives, add a narrowly scoped native binding before release; do not silently weaken these guarantees.

### 11.5 Source versus destination transactions

The observational consistency checks in section 10.5 must pass before staging a new destination transaction. Interrupted destination publication replays its complete staged bytes without new source access. On rerun, finish that committed transaction first, then perform a fresh complete source retrieval. A later sign-in/source failure is reported separately and returns status `1` even if previous publication recovery succeeded.

## 12. Privacy and security

- Make only authorized history/discovery/body-read requests plus the explicit browser-login and non-waking connection-broker operations. No prompt sending, read/unread marking, setting changes, uploads, agent/message mutations, or implicit cloud-box lifecycle changes.
- Authenticate through a validated user-mediated browser flow. Do not extract desktop credentials or inspect Keychain, cookie, secret, gateway, or unrelated configuration stores. Keep acquired session tokens only in process memory and never print them.
- Send authentication only to the verified service. Fetch returned storage URLs over HTTPS without forwarding the service bearer token. Validate redirects and destination origins; do not accept arbitrary URLs embedded in message content as fetch instructions.
- No exporter telemetry, AI processing, or transcript uploads. Network tests must prove requests are limited to authentication and authorized inbound history/body retrieval; a blanket no-network guarantee is incompatible with full history.
- Never log message bodies, credentials, or signed URLs. Temporary transcript staging uses mode `0600` and directories `0700` and follows the recovery cleanup policy.
- Never write inside Grok Bot's application-support directory. Reject any planned output root that equals, contains, or lies inside it, before creating a lock or staging files.
- Canonicalize the destination once; reject symlinks and unsafe managed paths. Preserve unrelated files.
- Disable Bun configuration autoload. The supported runtime environment has `BUN_OPTIONS` and `BUN_BE_BUN` unset; injected runtime overrides and compromised executables are outside this guarantee.
- Explain that exported notes can contain sensitive conversation content and that separately configured vault sync may transmit them.

## 13. Technical requirements

### 13.1 Runtime and packaging

- Implement in TypeScript with Bun **1.4.2**, revision **`744846f84`**, the stable locally tested build. Record both in build metadata and reject a mismatched toolchain in release builds. Do not build releases against a moving `latest` version.
- Support Apple Silicon Macs running macOS 13.0 or later in the initial release, subject to confirmation against the pinned Bun build during technical validation.
- Distribute the MVP as a versioned standalone `bun-darwin-arm64` executable with all application dependencies bundled. A Bun package invocation is not an MVP distribution path because it can load local configuration or install packages over the network.
- Compile with `autoloadDotenv: false`, `autoloadBunfig: false`, `autoloadTsconfig: false`, and `autoloadPackageJson: false`; keep runtime package auto-installation and dynamic network-loaded imports disabled.
- Include a committed lockfile, the pinned Bun version and revision, deterministic build commands, release checksums, and reproducible installation instructions.
- Treat an outbound-request allowlist trace, no-configuration-autoload test, and telemetry check as release gates for the compiled executable in the supported environment. Include isolated negative tests with `BUN_OPTIONS` and `BUN_BE_BUN` to document runtime override behavior, using synthetic files only. Pin and verify the complete runtime behavior; changing Bun requires rerunning these gates.

### 13.2 Internal architecture

Keep source parsing, normalization, rendering, and filesystem reconciliation separate:

```text
src/
  cli/
  source/
  normalize/
  render/
  export/
  diagnostics/
```

The normalized message model contains at least:

```text
accountId
agentId
agentName
entryId
role
content
timestamp
sourceOrder
sourceSchemaVersion
sourceGeneration
sourceSequence
sourceUpdatedSequence
sessionId
sourceKind
sourceRole
speaker
peer
contentHash
```

There is one full-history adapter boundary (including validated routing for supported agent types), one typed normalizer, and one fixed Markdown renderer. Authentication and body retrieval are separate from rendering and destination reconciliation.

### 13.3 Reliability

- Handle spaces, emoji, accents, and decomposed Unicode in paths and names.
- Avoid holding duplicate rendered copies of the entire archive in memory.
- Avoid rewriting unchanged output files.
- Reject symlinks in managed output paths and account conservatively for case-folding, Unicode normalization, and component-length collisions.
- Prefer a validated direct authenticated service transport that does not require the desktop app to be running; do not claim this until the login/transport spike passes.
- Never use cache coverage as a substitute for source retrieval. Failed history reads or mismatching full-account scans prevent publication. Only the explicit additional-session uncertainty in section 10.2 is permitted and reported.

## 14. Testing strategy

- Synthetic full-history transcripts exceeding 200 and 500 entries, thousands of mixed text/nontext rows, and multiple pages with zero visible text.
- Hidden/uncached agents, multiple sessions within the single account, legacy/current agent routing, group/peer attribution, empty authoritative conversations, and changed discovery inventories. An empty roster must still retain the account identity in `_export.md`.
- Exact gateway `id`/central `agentId` joins, distinct central record `id` and `legacyAgentId` values, missing/conflicting canonical IDs, same-name different bots, and gateway-only/server-only bots. Verify roster overlap does not duplicate a bot's session retrieval or output identity.
- Cursor repetition, page overlaps, uint64 values beyond JavaScript safe integers, generation changes, mid-scan old-message edits, deletion events, rate limits, timeouts, permission failures, and authentication expiry.
- Inline, blob-referenced, omitted, missing, corrupt, and mismatched bodies. Every raw row is accounted for; bad rows cannot disappear through filtering.
- Exact text bytes, timestamp/date grouping, YAML/entry-index offsets, repeated text with different IDs, and Markdown rendering limits.
- Reserved agent names including `_export.md`, `_EXPORT.MD`, `.grok-vault.lock`, and `.grok-vault-stage-example`; normalization, truncation, suffix, and file-versus-directory collisions must never occupy a reserved path or overwrite an unrelated file.
- Repeat exports, missing old history, source rewrites, manual edits, and undated-to-dated migrations. Validate exact-byte recovery of notes and `_export.md`, whole-root manual reset with preserved backups, and refusal to bypass a pending journal when manifest recovery is blocked.
- Fault injection at every journal/staging/commit/replay/cleanup boundary; simultaneous exporters, no-clobber target races, and source-unavailable replay. Include the `_export.md` manifest in publication/recovery tests.
- Trace the final binary to verify configuration isolation, no telemetry/uploads, and only approved auth/history/storage traffic. Test inherited runtime overrides separately using synthetic data.
- Compare a real, fully paginated export with the app's oldest reachable messages and independent source counts when available. Do not retain real-derived fixtures without explicit permission.
- Run minimum-OS/current-macOS, signing/distribution, filesystem, and Obsidian rendering checks. Research probes do not replace final-artifact tests.

## 15. MVP acceptance criteria

1. `grok-vault export <vault-path>` retrieves all returned text history for the user's single authenticated account's discovered agent/session inventory, with no total entry/page cap.
2. Every discovered conversation reaches an empty raw page, every raw row is resolved/classified, and two full-account scans match. `_export.md` records that evidence and all unverified session coverage without claiming an atomic snapshot.
3. Every in-scope message appears once under the correct conversation and speaker, with original text and source order preserved.
4. More than 200 entries, more than 500 entries, uncached agents, and additional sessions work. Local cache size has no effect on export completeness.
5. Discovery failures outside the permitted gateway-only box HTTP-404 case, unresolved bodies, unsupported rows, unfinished messages, and mismatching reads return `1` without publishing a new transaction. No cache fallback exists.
6. Unchanged complete snapshots leave generated bytes/mtimes unchanged. New messages append safely; source discrepancies preserve the archive and fail visibly.
7. Manual edits/unrelated files are preserved; per-note atomic publication and the durable journal recover interrupted writes, including completion-manifest publication.
8. Authentication is user-authorized, tokens are not extracted from local apps or retained on disk, source operations are read-only, and no transcript content is sent to third parties by the exporter.
9. The exact binary passes the runtime, filesystem, OS, and Obsidian release gates.

## 16. Delivery phases

### Phase 0: Source investigation and limitations

Browser-only discovery and default-history retrieval have been exercised without desktop-data access. Broader session/type coverage and an atomic source snapshot remain unproven. The approved observational export can ship as a development artifact with those limits explicit; it must not claim guaranteed completeness.

### Phase 1: Authenticated retrieval and normalization

Implement the proven authentication/discovery/pagination/body-resolution path, completeness accounting, and source consistency protocol. Exercise large synthetic histories and compare real paginated results with the validated source. Use synthetic or temporary research storage for validation. User-requested exports may publish under the observational policy in section 10.5.

### Phase 2: Archive publication and release

Implement daily rendering, safe identities, `_export.md`, manual-edit protection, and journaled publication. Pass interruption, concurrency, privacy/network-allowlist, distribution, macOS 13/current-macOS, and Obsidian tests on the final binary.

## 17. Risks and mitigations

| Risk | Required response |
| --- | --- |
| Authenticated external access is unavailable or incompatible | Stop source sign-off; choose another proven complete source with the user. Never substitute the cache. |
| Session discovery is unavailable | Report the narrowly permitted gateway-only box HTTP-404 uncertainty; all other failed discovery/history routes stop publication. |
| Service truncates pages or omits bodies | Verify raw pagination/body accounting and oldest boundary; fail unresolved rows. |
| History changes during retrieval | Compare two full-account reads including all older pages; bounded retry then fail. Disclose that transient changes can escape observation. |
| Source deletes or rewrites archived history | Preserve prior archive; report conflict rather than overwrite. |
| Private model-facing JSONL differs from visible chat | Validate projection explicitly; never equate raw model text with visible messages. |
| Runtime or dependencies contact unrelated services | Pin toolchain, disable autoload, and trace an explicit request allowlist. |
| Destination write is interrupted or races another exporter | Advisory lock, durable recovery journal, native no-clobber creation, and external-writer exclusion. |

## 18. Remaining service validation and release work

The remaining work is specific and must not be represented as already verified:

1. **Authentication — live access verified:** a fresh user-mediated PKCE token was accepted by the history service without credential extraction. Validate production cancellation, expiration, single-account identity, authorized team scope, and error handling. Account selection/switching is outside the MVP.
2. **Bot discovery:** the central roster supplements the gateway list/count. Broader validation is needed for empty accounts, hidden/group/server-only agents, inventory changes, and sleeping boxes. Session-list HTTP 404 does not prove absence of additional sessions; the permitted uncertainty is documented in section 10.2.
3. **History:** raw pagination has been exercised through empty terminal pages. Authoritative retention guarantees and live blob/omitted-body cases need further validation. Public fixtures must remain synthetic.
4. **Consistency — unresolved:** complete-scan comparisons provide observational stability, not proof of an atomic snapshot or a complete change-feed boundary. Validate generation/update semantics and detection of concurrent old-row edits, insertions, deletions, and inventory changes. A watch heartbeat alone is not a completion barrier.
5. **Long histories:** synthetic tests cover more than 200/500 rows and sequences beyond `2^53`. Live per-conversation long-history validation remains separate; aggregate account counts do not establish that case.
6. **Protocol compatibility — partial:** successful list/history calls and the session-list discrepancy are recorded. Validate rate limits, permission boundaries, retries, legacy discovery, and termination guarantees for the final adapter. Do not infer support for every agent/session type from a successful run on supported types.

Record exact versions, method contracts, observed counts, and limitations as these checks pass. These are requirements for stronger coverage claims and broader release validation; they do not block the user-approved observational export policy in section 10.5.

## 19. Resolved product decisions

- **All retained conversation text is the intended outcome.** A bounded-cache exporter is not an acceptable MVP or fallback.
- Preserve the destination-only command and local Markdown/Obsidian output. Browser authentication is the only account-access mechanism; no local Grok Bot installation, running desktop app, cache, or credential-store access is required. The cloud gateway and history service supply the data.
- Assume one account per user and output root. Enumerate all of its accessible agents and sessions, including supported team/group conversations; retain participant attribution and avoid cross-session ID collisions. No account selection, switching, or merging is required.
- **Approved policy:** publish after two matching full-account scans and record unverified additional-session inventories explicitly. An atomic snapshot guarantee is not required for this observed export. Unresolved bodies, failed discovered histories, and silently skipped conversations still prevent success.
- Keep private reasoning, tool internals, UI controls, and attachment payloads outside the original text scope, with explicit classifications/counts.
- Never extract existing desktop credentials. Authenticate with user-mediated consent and keep resulting tokens only in memory.
- Keep exact text, fixed archive timezone, safe generated-file ownership, manual-edit preservation, and journaled recovery.
- Previous cache-only source, offline/no-network, no-authentication, cache-prefix-success, and implementation-ready decisions are superseded by this correction.

## 20. Research references

The [source contract](docs/source-contract.md) records the public protocol assumptions and validation limits. Private research artifacts are excluded from version control.

- [Grok Lens desktop replica reader — pinned source](https://github.com/monomyth/grok-lens/blob/dfbb71328cac666a7aec6c26c24183c3f9be6de3/lib/grok_lens/bot.rb)
- [Skarn manual — supporting desktop-format documentation](https://getskarn.com/manual/)
- [Vibe Replay parser — cloud-box format, not desktop blobs](https://github.com/tuo-lei/vibe-replay/blob/794cc6b8c85b413dba8b0359dd21b78113a3ff11/packages/provider-grok-bot/src/grok-bot/parser.ts)
- [Vibe Replay storage analysis — pinned article source](https://github.com/tuo-lei/vibe-replay/blob/794cc6b8c85b413dba8b0359dd21b78113a3ff11/website/src/content/blog/grok-bot-local-storage.md)
- [grok-bot-mcp — gateway/host SQLite integration, outside the MVP source boundary](https://github.com/Kargatharaakash/grok-bot-mcp/blob/572b95ab953f5afc782fb6a16ed2eb084b9fc730/server.mjs)
- [Bun standalone executables and runtime overrides](https://bun.com/docs/bundler/executables)
- [Bun installation and minimum platform requirements](https://bun.com/docs/installation)
- [Apple advisory file-lock semantics](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/flock.2.html)
- [CommonMark reference-link scope](https://spec.commonmark.org/0.31.2/#link-reference-definitions)
