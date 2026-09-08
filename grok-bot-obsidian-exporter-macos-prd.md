# Product Requirements Document: Grok Vault for macOS

## 1. Document status

- **Status:** Ready for technical validation; implementation is gated on Phase 0
- **Working product name:** Grok Vault
- **Product type:** Local command-line utility
- **Runtime:** Bun with TypeScript
- **Supported platform:** Apple Silicon macOS 13.0 or later, pending validation against the pinned Bun build
- **Source application:** Grok Bot desktop app for macOS
- **Destination:** A user-selected Obsidian vault or local directory

## 2. Product summary

Grok Vault exports the visible conversation belonging to each Grok Bot agent into Markdown files organized for Obsidian. Because each agent has one continuing conversation rather than a list of chats, the exporter divides the transcript into daily notes while preserving message order.

The product has one workflow and one command:

```bash
grok-vault export "/Users/me/Documents/Obsidian/My Vault"
```

The command automatically finds the local Grok Bot data, exports every available agent, and writes this fixed structure:

```text
Grok Bot/
  Researcher/
    2026-09-07.md
    2026-09-08.md
  Chief of Staff/
    2026-09-07.md
```

The MVP is local-only and read-only with respect to Grok Bot. It does not require a Grok Bot skill, cloud access, gateway credentials, an xAI API key, or an Obsidian plugin.

## 3. Background

The Grok Bot macOS application maintains a local presentation-oriented replica at:

```text
~/Library/Application Support/Grok Bot/sand-client-persistence
```

Community utilities have documented this store as a collection of `.blob` files. Each filename is an unpadded lowercase Base32 encoding of a dotted persistence key. Relevant decoded keys include:

```text
sand.client.slice.account.<account-id>.transcript.replicas.<agent-id>
sand.client.slice.account.<account-id>.roster.last-roster
sand.client.slice.account.<account-id>.sidebar.last-sections
```

Transcript blobs are JSON envelopes whose `value.entries` array contains the locally visible transcript. Roster data maps agent IDs to display names.

This format is reverse-engineered rather than a published xAI export contract. Grok Vault must detect unsupported data and fail visibly instead of silently producing an incomplete archive.

## 4. Problem statement

Users who work with long-lived Grok Bot agents cannot easily preserve those continuous conversations as portable notes in Obsidian. Manual copy and paste is slow, loses chronology, and becomes impractical as transcripts grow.

The product should make export feel like copying a durable snapshot into the user's vault: one command, predictable output, and no setup beyond supplying the destination.

## 5. Goals

- Export the visible user and assistant messages for every locally available Grok Bot agent.
- Produce readable Markdown that works in Obsidian without plugins.
- Organize output into one directory per agent and one note per calendar day.
- Preserve original message order and content.
- Make repeated exports deterministic and duplicate-free.
- Continue exporting safely after a recognized prefix truncation of the local Grok Bot replica.
- Protect prior exports from accidental deletion or overwrite.
- Keep Grok Bot source data strictly read-only.
- Provide a concise success summary or a clear actionable error.

## 6. Success criteria

- A first-time user can run the exporter with one command.
- Every supported visible message appears exactly once in the output.
- Running the command twice against unchanged data does not change any Markdown file.
- New messages are incorporated without duplicating existing messages.
- A recognized prefix truncation preserves archive-only messages while allowing new messages to be exported.
- Unsupported or malformed transcript data causes the entire invocation to stop during preflight with a clear error and no generated-note changes.
- Existing non-Grok-Vault files are never overwritten.
- Grok Bot remains usable and its local data remains unchanged.

## 7. Non-goals for the MVP

- Commands other than `export`.
- Optional source, agent, date, output-name, format, timezone, watch, dry-run, verbose, or JSON flags.
- Windows or Linux support.
- A graphical application, menu bar application, or Obsidian plugin.
- Exporting Grok conversations from the X web or mobile applications.
- Accessing Grok Bot's cloud-computer transcript store.
- Exporting private reasoning, hidden prompts, tool-call internals, tool results, approvals, widgets, or attachments.
- Reconstructing group chats or merging subagent transcripts.
- Calling an undocumented gateway or reading authentication tokens.
- Reading Grok Bot cookies, secrets, credentials, or macOS Keychain data.
- Modifying or repairing Grok Bot data.
- Importing Markdown into Grok Bot.
- Summarizing, tagging, redacting, or otherwise transforming transcript content with an AI model.
- Continuous watching, scheduled background operation, or launch-at-login behavior.
- A Grok Bot skill or routine.
- A configuration file or persistent exporter database.
- Cloud synchronization of the Obsidian vault.

## 8. User experience

### 8.1 Command

```bash
grok-vault export <vault-path>
```

Example:

```bash
grok-vault export "/Users/me/Documents/Obsidian/My Vault"
```

The destination path is the command's only product input. Standard CLI behavior for `--help` and `--version` is permitted, but neither changes export behavior.

### 8.2 Automatic behavior

The command must:

1. Find the fixed Grok Bot persistence directory under the current user's Library.
2. Validate that the source and destination directories are safe and readable or writable as appropriate.
3. Discover every supported local agent transcript.
4. Resolve agent display names from the local roster.
5. Normalize supported visible messages.
6. On a new archive, capture the Mac's current IANA timezone and group messages into daily notes using that fixed archive timezone.
7. Create or reconcile the fixed `Grok Bot` output directory.
8. Print a concise summary and exit.

The user does not select agents, dates, source paths, templates, or output formats in the MVP.

### 8.3 Successful output

Example:

```text
Exported 4 agents and 1,284 messages to:
/Users/me/Documents/Obsidian/My Vault/Grok Bot

Created 3 files, updated 1, unchanged 42.
```

### 8.4 Error output

Errors must say what prevented a safe export and what the user can do next. Examples include:

- Grok Bot data was not found. Open Grok Bot and allow it to finish loading, then try again.
- The destination directory does not exist or is not writable.
- A transcript uses an unsupported schema. Update Grok Vault before exporting again.
- An existing file appears to have been edited manually. Move or rename it before trying again.

The command exits with status `0` only when every discovered supported transcript was exported successfully or safely merged with a recognized prefix truncation. Any incomplete, ambiguous, or unsafe export exits with status `1`. A recognized prefix truncation produces a warning but remains a successful export.

## 9. Output specification

### 9.1 Fixed directory structure

- The output root is always `<vault-path>/Grok Bot`.
- Every agent receives one immediate child directory.
- Every dated transcript file is named `YYYY-MM-DD.md`.
- Messages without a usable timestamp are written to `_undated.md` in source order.
- `_undated.md` uses `date: null` in frontmatter and `## Undated — <speaker>` headings.
- Filesystem modification times must never be used as message timestamps.

### 9.2 Agent directory names

- Prefer the roster display name.
- Replace `/`, `:`, NUL, control characters, empty names, `.` and `..` with safe equivalents.
- Normalize names to NFC, trim surrounding whitespace, and use a conservative NFD-plus-case-folded collision key even when the destination volume is case-sensitive.
- Keep each path component within 255 UTF-8 bytes. Truncate at a grapheme boundary and append a stable identifier when necessary.
- If two agents have the same safe display name, append a short stable identifier.
- If no display name is available, use `Unnamed Agent — <short-id>`.
- Use `(account ID, agent ID)` as the internal agent identity.
- On later exports, scan existing generated frontmatter to find the directory already associated with that identity. Reuse that directory even if the agent's display name has changed. This prevents duplicate folders without requiring external state.
- If one identity appears in multiple directories, one directory contains generated files for multiple identities, or an otherwise suitable directory contains only unrelated files, do not guess. Report a conflict or choose a stable suffixed directory without modifying unrelated content.
- When an agent is renamed, retain its existing directory but update the generated frontmatter and assistant headings in every verified generated note to the current roster name.
- Never construct or follow an output path that resolves outside the selected destination.

### 9.3 Date grouping and archive timezone

- On the first export into an empty output, capture the Mac's current IANA timezone identifier as the archive timezone.
- Record `archive_timezone` in every generated note. All generated notes in one output root must agree on this value.
- On later exports, use the recorded archive timezone even if the Mac's system timezone has changed. A system timezone change must never move an already exported message between files.
- The exporter has no timezone setting or timezone flag.
- Convert each newly observed supported timestamp to a local date and time using the archive timezone.
- Preserve archive order when timestamps are equal, missing, or move backward during a daylight-saving transition.
- When no valid generated note remains, a later run establishes a new archive timezone from the Mac's then-current timezone.

### 9.4 Markdown format

Each daily note uses this structure:

```markdown
---
source: "grok-bot"
generated_by: "grok-vault"
format_version: 1
account_id: "account-example"
agent_id: "agent-example"
agent: "Researcher"
date: "2026-09-07"
archive_timezone: "America/Chicago"
entry_index:
  - id: "t0u"
    role: "user"
    source_timestamp: "2026-09-07T19:03:00.000Z"
    archive_order: 0
    content_offset: 18
    content_bytes: 34
    content_hash: "sha256:example-user"
  - id: "t0a"
    role: "assistant"
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

- Preserve message text byte-for-byte after decoding the source string. Do not repair malformed Markdown; well-formed paragraphs, lists, links, tables, and code fences must retain their meaning in Obsidian.
- Label user messages `You` and assistant messages with the agent's resolved display name.
- Render local timestamps using 24-hour time.
- Quote or escape frontmatter values safely.
- Store an authoritative `entry_index` in each note. For every entry it records the source ID, role, source timestamp or `null`, stable archive order, SHA-256 content hash, and the UTF-8 byte offset and length of the unmodified message content. The note body begins with the first byte after the blank line following the closing frontmatter delimiter; offsets are measured from that byte.
- Treat the entry index, not delimiter-like text in a message body, as authoritative for duplicate detection, content extraction, and reconciliation. Message content may contain text resembling exporter metadata without affecting parsing.
- Calculate `render_hash` over the exact UTF-8 bytes of the complete generated file after removing exactly the one canonical `render_hash` key-value line and its terminating LF. This covers all other managed frontmatter, the entry index, headings, message content, and line endings without requiring an external database.
- Calculate each `content_hash` over the exact UTF-8 bytes represented by that entry's `content_offset` and `content_bytes` slice.
- Render deterministically with UTF-8 and use LF for exporter-generated structural line endings. Do not normalize line endings inside message content. Reject duplicate frontmatter keys and malformed managed metadata.
- Do not add tags, backlinks, summaries, topics, or Obsidian wikilinks.

## 10. Source discovery and parsing

### 10.1 Store discovery

- Read only the fixed persistence path under the current macOS user's Library directory.
- Resolve the user's home directory through runtime APIs.
- Do not recursively search unrelated directories.
- If the fixed source path is unavailable, stop without changing existing output.

### 10.2 Slice filename decoding

- Decode unpadded lowercase Base32 filenames according to the observed RFC 4648-compatible format.
- Classify decoded transcript-replica and roster keys.
- Ignore unrelated slices without opening known cookie, secret, credential, or gateway stores.
- Maintain an allowlist of known non-slice artifacts in the persistence directory. Treat every other regular-file candidate whose name cannot be decoded as an error, without opening its contents.

### 10.3 Transcript validation

- Parse the top-level JSON envelope.
- Require a supported `schemaVersion`, `value` object, and `value.entries` array.
- Treat unknown schemas as unsupported, not as empty transcripts.
- Stop the entire invocation during preflight on malformed JSON or an unsupported transcript schema. Do not update other agents first.
- Never replace an existing successful export with empty output after a parsing failure.

### 10.4 Entry normalization

For each transcript entry:

- Recognize visible `user` and `assistant` messages.
- Prefer a string at `entry.content`.
- Support the observed fallback string at `entry.message.content`.
- Require a stable, nonempty source entry ID for every supported visible message and preserve it exactly.
- Treat a content hash as a fingerprint, never as message identity. If the observed source schema can omit IDs, that schema remains unsupported until an occurrence-aware sequence design can prove exact-once reconciliation.
- Reject duplicate source IDs within one account-and-agent conversation, including duplicates with identical content.
- Preserve source array order as the authoritative message order.
- Normalize each supported timestamp to a canonical UTC instant for storage and comparison, then derive its displayed date and time using the archive timezone.
- Accept an absent timestamp as undated and store `source_timestamp: null`. Treat a timestamp field with an unexpected type, unit, timezone interpretation, or invalid value as an unsupported shape rather than silently making it undated.
- Exclude entries explicitly marked as still streaming and count them in the summary as deferred.
- Report and fail on an entry that appears to contain visible message content in an unsupported shape.
- Ignore non-message entries that have no visible text.
- Never infer or reconstruct hidden reasoning or tool activity.

### 10.5 Agent resolution

- Join transcript agent IDs to roster data for display names.
- Treat one transcript replica as one persistent agent conversation.
- Keep accounts distinct even if they contain identical agent IDs or display names.
- Deduplicate byte-identical replicas for the same account and agent.
- If replicas for the same account and agent disagree and no safe deterministic choice is possible, stop the entire invocation during preflight and report the conflict.

## 11. Reconciliation and file safety

Every invocation performs a complete one-shot export. There is no separate synchronization mode and no persistent state database. The verified frontmatter and entry index embedded in each generated note are the archive's only reconciliation metadata.

### 11.1 Generated-file ownership

- Ownership is determined per file, never by directory alone.
- A file is exporter-owned only when its frontmatter contains the expected `source` and `generated_by` values, a supported `format_version`, an account ID, an agent ID, an agent name, a date or `null`, the archive timezone, a valid entry index, and a valid `render_hash` covering the complete generated file except for the hash field itself.
- If a file claims `generated_by: grok-vault` but has missing, malformed, duplicate, unsupported, or hash-invalid managed metadata, treat it as a conflict. Do not silently reclassify it as unmarked.
- Never overwrite or delete an unmarked file.
- Preserve unrelated files and directories anywhere beneath `Grok Bot`.

### 11.2 Manual edits

Before replacing an existing generated file:

1. Recompute the hash of the complete generated file with its `render_hash` field omitted.
2. Compare that value with its stored `render_hash`.
3. Validate every entry-index offset, length, content hash, source ID, and archive-order value against the body.
4. If any check differs or fails, treat the file as manually edited or corrupted and stop the entire invocation before overwriting anything.

The MVP has no force or conflict-resolution flag. The error tells the user to move, rename, or delete the edited file and run the command again.

### 11.3 Archive merge and missing source messages

Grok Bot's local replica may eventually compact or truncate older history. Therefore:

- Never remove a previously exported message merely because it is absent from the current source snapshot.
- Never delete an existing generated daily note automatically.
- Reconstruct each agent's verified archive sequence from its generated entry indexes, ordered by unique contiguous `archive_order` values.
- Match current source entries to archive entries by source ID. Every overlapping entry must retain the same role and content. Its timestamp must also match, except that a previously absent timestamp may become valid and move that entry out of `_undated.md` without changing its archive order.
- A safe extension exists when the overlapping source IDs form both a suffix of the verified archive sequence and a prefix of the current source sequence, in the same order. Preserve any archive-only prefix, retain the overlap, and append the new source-only suffix with new archive-order values.
- When the safe extension preserves an archive-only prefix, report the number of preserved messages as a recognized local-replica truncation warning and continue successfully.
- Treat an empty snapshot following a nonempty archive, no shared IDs, deletion from the middle or end of the archive, reordered overlap, changed content or role, a changed valid timestamp, or new entries inserted before or within the overlap as ambiguous. Stop the entire invocation without changing output.
- If an undated entry gains a valid timestamp and leaves `_undated.md` empty, retain the existing file as a valid metadata-only generated note rather than deleting it.
- The user may deliberately delete all generated notes for an affected agent and run a fresh export if they want that agent's archive to match only the current local replica.

This archive-preserving behavior is fixed for the MVP and requires no option.

### 11.4 Preflight and safe replacement

Every invocation uses two phases.

During preflight, before replacing any generated note:

1. Obtain a stable source snapshot and parse every selected transcript and roster blob.
2. Validate and normalize every supported visible entry.
3. Scan all relevant existing output, validate ownership and hashes, resolve identities, perform archive reconciliation, and render every intended note.
4. Check destination containment, symlinks, conflicts, permissions, and the current metadata of every file that may be replaced.
5. If any expected validation, schema, identity, reconciliation, edit, or filesystem check fails, exit with status `1` without changing any generated note.

After preflight succeeds:

1. Leave every byte-identical file untouched.
2. Create each changed note as a uniquely named temporary sibling using exclusive creation.
3. Apply the intended permissions and flush each temporary file with `fsync`.
4. Immediately before replacement, verify that the destination still has the identity and metadata observed during preflight.
5. Atomically rename the temporary sibling over the previous generated file or into its new name.
6. `fsync` the containing directory after each rename and remove temporary files created by the current process on failure.

Atomicity is guaranteed per note, not across the entire invocation. An interruption during commit may leave a subset of complete notes updated, but never a partially written note. A later run must recognize that state and converge safely. A concurrent output change detected during commit causes the remaining replacements to stop and the command to exit with status `1`.

### 11.5 Snapshot consistency

Grok Bot may replace persistence blobs while running. The exporter must:

1. Enumerate the persistence directory and record the selected filenames plus device, inode, size, and nanosecond-resolution modification time for every selected source blob.
2. Open selected blobs read-only, read and parse all of them, and retain a digest of the bytes read.
3. Re-enumerate the directory and verify every recorded metadata value after the read.
4. Retry the entire enumeration and read at most three times if any selected file, directory entry, or metadata value changed.
5. Stop during preflight without modifying generated notes if a stable snapshot cannot be obtained.

## 12. Privacy and security

- Open Grok Bot source files read-only.
- Never write inside the Grok Bot application-support directory.
- Never request Full Disk Access when normal user permissions suffice.
- Never access the macOS Keychain.
- Never read cookies, tokens, secrets, credentials, or gateway configuration.
- Never enumerate process environment variables or automatically load `.env`, `bunfig.toml`, package metadata, preloads, or other configuration from the working directory.
- Never send transcript content over the network.
- Include no telemetry.
- Never log message bodies.
- Resolve the user-selected destination once to a canonical directory, then validate every output path beneath it before writing.
- Reject a destination that is the Grok Bot source directory or lies inside it.
- Reject symlinks in `Grok Bot` or any managed path beneath it rather than following them, even when their current target remains inside the destination. Use no-follow file operations where the runtime exposes them.
- Warn that exported notes contain any sensitive information the user placed in Grok Bot conversations.

## 13. Technical requirements

### 13.1 Runtime and packaging

- Implement in TypeScript and pin the exact stable Bun version and revision selected during development. Do not build releases against a moving `latest` version.
- Support Apple Silicon Macs running macOS 13.0 or later in the initial release, subject to confirmation against the pinned Bun build during technical validation.
- Distribute the MVP as a versioned standalone `bun-darwin-arm64` executable with all application dependencies bundled. A Bun package invocation is not an MVP distribution path because it can load local configuration or install packages over the network.
- Compile with `autoloadDotenv: false` and `autoloadBunfig: false`; keep runtime package auto-installation and dynamic network-loaded imports disabled.
- Include a committed lockfile, the pinned Bun version and revision, deterministic build commands, release checksums, and reproducible installation instructions.
- Treat a no-network runtime trace, no-configuration-autoload test, and telemetry check as release gates for the compiled executable.

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
contentHash
```

There is one desktop-replica source adapter and one fixed Markdown renderer in the MVP.

### 13.3 Reliability

- Handle spaces, emoji, accents, and decomposed Unicode in paths and names.
- Avoid holding duplicate rendered copies of the entire archive in memory.
- Avoid rewriting unchanged output files.
- Reject symlinks in managed output paths and account conservatively for case-folding, Unicode normalization, and component-length collisions.
- Do not require Grok Bot to be running.
- Explain that the local replica may be stale until Grok Bot has opened and synchronized.

## 14. Testing strategy

### 14.1 Fixtures

- Build synthetic fixtures for every supported envelope and entry shape.
- Obtain explicit permission before retaining any fixture derived from a real transcript.
- Fully redact real fixtures.
- Record the observed Grok Bot and schema versions associated with each fixture family.
- Cover multiple available Grok Bot app builds and include renamed, hidden, and deleted agents; multiple accounts when observable; duplicate message text; streaming transitions; and compacted history.

### 14.2 Unit tests

- Base32 filename decoding and slice classification.
- Envelope and schema validation.
- Entry normalization variants.
- Required source IDs, duplicate-ID rejection, and rejection of ambiguous ID-less identical messages.
- Fixed archive-timezone grouping, including daylight-saving transitions and a later system-timezone change.
- Agent-name sanitization, byte-length limits, case-folding, Unicode-normalization collisions, and stable truncation.
- Multi-account identity collisions.
- YAML quoting, arbitrary marker-like message text, entry-index offsets, and well-formed Markdown preservation.
- Content fingerprinting without treating hashes as identity.
- Whole-file render-hash creation and edits to managed frontmatter, entry indexes, headings, content, and line endings.
- Output path and symlink containment.
- Deterministic rendering.

### 14.3 Integration tests

- Discover the fixed synthetic macOS persistence path.
- Join roster names to transcript replicas.
- Export multiple accounts and agents across multiple days.
- Run the command twice and verify that unchanged files are untouched.
- Add a new message and verify it appears once.
- Simulate recognized prefix truncation plus new messages; verify the archive-only prefix is preserved, the new suffix is exported, a warning is reported, and the command succeeds.
- Simulate middle deletion, reordered overlap, changed content, a nonempty archive followed by an empty snapshot, and a snapshot with no shared IDs; verify preflight fails with zero generated-note changes.
- Move an undated entry when its timestamp first becomes valid and retain an empty `_undated.md` as metadata-only output.
- Rename an agent and verify its directory is reused while verified frontmatter and assistant headings are updated.
- Simulate edits to the body and each managed frontmatter class; verify the entire invocation stops before overwriting anything.
- Simulate interruption during a multi-file commit; verify every affected note is individually complete and the next run converges.
- Refuse an unsafe destination or any symlink in a managed output path.
- Stop with zero generated-note changes when one transcript is malformed or when a stable source snapshot cannot be obtained in three attempts.
- Run the compiled executable in a directory containing `.env`, `bunfig.toml`, and preload files and verify none is read or executed.
- Trace the compiled executable during export and verify it makes no network request and emits no telemetry.

### 14.4 Manual validation

- Compare exported visible messages with the Grok Bot desktop interface.
- Test while Grok Bot is closed, idle, synchronizing, and streaming a reply.
- Verify rendering in Obsidian for paragraphs, lists, tables, links, code fences, and long messages.
- Test vault and agent paths containing spaces and Unicode.
- Change the Mac's timezone after a successful export and verify that existing messages do not move between files.
- Confirm that no Grok Bot source file is modified.

## 15. MVP acceptance criteria

### 15.1 One-command operation

- `grok-vault export <vault-path>` is the only product command.
- The command automatically finds the macOS Grok Bot store.
- The command automatically exports every supported local agent.
- No configuration or additional export option is required or supported.

### 15.2 Export correctness

- Every supported visible user and assistant message appears exactly once.
- Every exported visible message has a stable, unique source ID; schemas that cannot provide one are rejected before output changes.
- Source ordering is preserved as stable archive order.
- Messages are grouped into daily files using the archive timezone captured from the Mac's local calendar on first export.
- Missing timestamps are represented in `_undated.md` without guessing.
- Message text is retained byte-for-byte after source decoding, and well-formed Markdown and code blocks retain their meaning in Obsidian.
- Duplicate display names and multiple accounts cannot overwrite one another.

### 15.3 Repeatability and safety

- A second export from unchanged data does not change file content or modification times.
- New messages are added without duplicating existing entries.
- A recognized compacted prefix is preserved while an unambiguous new suffix continues to export successfully.
- Ambiguous missing, reordered, inserted, or changed historical messages stop the invocation during preflight.
- Changed notes are replaced atomically per file; an interrupted multi-file commit converges on the next run.
- Manually edited or corrupted generated files are detected by whole-file and entry-index validation and preserved.
- Unmarked files are never overwritten or deleted.
- Foreseeable validation, reconciliation, schema, identity, and filesystem failures detected during preflight produce zero generated-note changes.
- Malformed or unsupported source data never replaces a valid existing export with partial or empty output.
- No Grok Bot source file is changed.
- The compiled executable does not load local runtime configuration, make a network request, inspect credentials, or emit telemetry.

### 15.4 Reporting

- A successful run identifies the destination and reports agents, messages, created files, updated files, and unchanged files.
- Streaming messages deferred until the next run are counted.
- Archive-only messages preserved after recognized prefix truncation are counted and reported as a warning without changing the successful exit status.
- An incomplete or unsafe export returns status `1` with an actionable explanation.
- Generated notes open correctly in Obsidian without a plugin.

## 16. Delivery phases

### Phase 0: Format and design validation

- Collect redacted macOS fixtures across multiple available Grok Bot app builds and at least two agents, including renamed or hidden agents and multiple accounts when observable.
- Confirm Base32 decoding, schema versions, stable unique entry IDs, timestamp fields and units, content variants, roster joining, and streaming behavior.
- Compare local entries with the desktop UI to define visible-message coverage.
- Determine whether the desktop replica compacts or truncates only a prefix, whether it can rewrite completed entries, and whether retained overlap remains ordered.
- Validate the whole-file render hash, authoritative entry index, fixed archive timezone, prefix-merge algorithm, and two-phase commit design.
- Pin the Bun release and confirm macOS 13.0 support, disabled configuration autoload, no runtime network access, and no telemetry in the compiled executable.

### Phase 1: Read and normalize

- Implement fixed source discovery, three-attempt stable snapshot reading, filename decoding, schema validation, roster joining, required source-ID validation, and entry normalization.
- Establish concise diagnostics and exit behavior.
- Verify read-only operation.

### Phase 2: Export and harden

- Implement fixed output paths, hardened agent directories, archive-timezone grouping, Markdown rendering, authoritative entry indexes, whole-file ownership detection, prefix reconciliation, preflight, and per-note atomic writes.
- Add fixture, integration, macOS, and Obsidian tests.
- Build the pinned standalone executable, pass the privacy release gates, and document the one-command workflow.

## 17. Risks and mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| xAI changes the undocumented schema | Export becomes incomplete or incorrect | Strict schema checks, fixture-backed parser versions, and fail-visible behavior |
| Stable source IDs are absent or reused | Exact-once reconciliation becomes impossible | Require unique IDs for supported messages; fail before writing instead of substituting content hashes |
| Local replica omits or truncates older history | Archive could lose messages or stop accepting new ones | Preserve a recognized archive-only prefix, append only an unambiguous new suffix, and fail on other patterns |
| Grok Bot rewrites files during export | Mixed snapshot | Validate directory membership and file metadata for the entire snapshot before writing and retry at most three times |
| Missing timestamps prevent daily grouping | Incorrect dates | Preserve order in `_undated.md`; never use filesystem timestamps |
| System timezone changes | Existing messages could move between dates | Capture one archive timezone on first export and reuse it for all later exports |
| Agent names or filesystem-normalized paths collide | Duplicate folders or overwrite | Use account and agent IDs, conservative collision keys, byte limits, and stable suffixes |
| User edits generated notes or metadata | Export could destroy notes or misidentify ownership | Verify the whole-file render hash and authoritative entry index before any replacement |
| The runtime loads local configuration or dependencies | Credentials could be read or network traffic could occur | Ship a pinned standalone binary with configuration autoload disabled and enforce privacy release gates |
| A process stops during a multi-file commit | The archive may contain old and new complete notes together | Guarantee per-note atomicity and require the next invocation to converge safely |
| Sensitive content enters a synced vault | Increased exposure | Local-only processing, clear warning, and no logs, network calls, or telemetry |

## 18. Open validation questions

These questions require real macOS fixtures but do not introduce user-facing options:

1. Do all current visible user and assistant entries have stable, unique IDs, including after restart and synchronization?
2. What timestamp fields and units occur in current visible-entry variants?
3. Does the desktop replica retain complete agent history, truncate only a prefix, or rewrite completed entries?
4. When is `isStreaming` reliably cleared after a reply finishes?
5. Can multiple nonidentical replicas exist for the same account and agent, and what metadata identifies the current one?
6. Which current Grok Bot app and schema versions must the initial release support?
7. Does the pinned stable Bun build satisfy the no-configuration, no-network, and no-telemetry release gates on macOS 13 and later?

## 19. Resolved product decisions

- The MVP supports only the Grok Bot macOS desktop application.
- The local `sand-client-persistence` replica is the only source.
- `grok-vault export <vault-path>` is the only product command.
- The destination path is the only export input.
- The source location, exported agents, `Grok Bot` output name, Markdown format, and archive-timezone date grouping are automatic and fixed.
- There is no sync command, watch mode, configuration, timezone option, filtering, dry run, verbose mode, or machine-readable output.
- Re-running `export` safely reconciles new messages.
- The first export captures the Mac's current IANA timezone; later exports reuse it without moving existing messages when the system timezone changes.
- The output is one directory per agent and one Markdown file per archive-calendar day.
- The exporter captures visible text, not hidden reasoning or tool internals.
- Supported visible messages require stable unique source IDs; content hashes are fingerprints, not identities.
- No Grok Bot skill is required.
- No cloud transcript, gateway, SQLite, authentication-token, or Keychain integration is permitted.
- Generated Markdown is deterministic and contains a verified authoritative entry index and whole-file render hash; no external state database is used.
- Recognized prefix truncation preserves archive-only history and permits an unambiguous new suffix to export; other historical discrepancies fail during preflight.
- Foreseeable preflight failures change no generated note, while commit-time atomicity is guaranteed per note and converges on rerun.
- The MVP is distributed as a pinned standalone Apple Silicon executable with local configuration autoload and runtime dependency installation disabled.
- Grok Bot inputs remain read-only and transcript content never leaves the Mac.

## 20. Research references

- [xAI: Create and manage Bots](https://docs.x.ai/grok-bot/bots)
- [Skarn manual: Grok Bot local replica format](https://getskarn.com/manual/)
- [Grok Lens](https://github.com/monomyth/grok-lens)
- [Vibe Replay](https://github.com/tuo-lei/vibe-replay)
- [Vibe Replay: Grok Bot local storage analysis](https://vibe-replay.com/blog/grok-bot-local-storage/)
- [grok-bot-mcp](https://github.com/Kargatharaakash/grok-bot-mcp)
- [GrokBot SDK](https://github.com/adam91holt/grokbot-sdk)
- [Bun runtime documentation](https://bun.sh/docs/runtime)
- [Bun standalone executable documentation](https://bun.sh/docs/bundler/executables)
- [Bun environment-variable and `.env` behavior](https://bun.sh/docs/runtime/environment-variables)
