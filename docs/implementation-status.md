# Implementation status — 2026-09-08

The development CLI implements browser-only observational exports. A successful authenticated CLI export has been reported; private account details and transcripts are excluded from this repository. Synthetic checks establish the behaviors below, without proving that the provider exposes every retained message or session.

## Implemented

- Destination-only CLI, browser PKCE sign-in with cancellation/expiry handling, in-memory credentials, sanitized diagnostics, a read/broker allowlist, bounded request retries, HTTPS checks, and credential separation between service/gateway/storage.
- Exact gateway `id` / central `agentId` union with duplicate/count/conflict checks, hidden bot retention, repeated discovery, routing provenance, and default-session accounting. HTTP 404 for a gateway-only box bot marks additional-session inventory unverified; registered/server-only/temporal bot errors and access-denied responses remain fatal.
- Unbounded page traversal with lossless uint64 sequences, generation/cursor checks, strict body/row identity validation, omitted-body re-reads, signed blob retrieval with hash validation, explicit exclusions, and failure on unknown text/attribution/streaming states.
- Exact-content Markdown with hash-verified frontmatter and byte indexes, daily/session folders, Unicode-safe reserved names, stable directory identities, persistent timezone, and empty-conversation/account metadata.
- Archive reconciliation, source-rewrite/manual-edit protection, OS locking, exclusive staging, destination permission preflight, no-clobber new targets, atomic replacements, durable journal replay before source access, and conservative cleanup.
- A pinned standalone Apple Silicon build with configuration autoload disabled, checksums, and separate binary verification.
- An offline publication check for current and staged files, backed by ignore rules for real exports, credentials, captures, local research, and generated output. Pattern scanning supplements manual review; it cannot prove the absence of every form of sensitive information.

## Reproducible validation

Run `bun run check`, `bun run check:public`, `bun run build`, and `bun run verify:binary`. The generated `dist/build.json` and `dist/binary-validation.json` describe the artifact and tested boundaries. These commands use synthetic data and do not authenticate or contact the source service.

Recorded on the development Mac: strict TypeScript checking and all **106 Bun tests passed**. The publication check passed, and the rebuilt **0.1.0-dev.2** executable passed standalone binary verification.

The synthetic cases cover histories beyond 200 entries and 500 messages, uint64 sequences above `2^53`, pages containing only excluded rows, body/identity errors, multiple sessions, unchanged bytes/mtimes, bot renames, Unicode/path collisions, manual edits, timestamp migration, interrupted staging/publication/cleanup, source-unavailable replay, and credential/allowlist behavior. Separate-process tests cover lock exclusion and OS process death after commit/publication/completion.

Permissions regressions use real mode `0500` directories on the development Mac. An unwritable bot/session directory or ancestor prevents commitment and preserves every existing note and manifest byte and mtime. Recovery checks remaining-write and journal-cleanup permissions; unchanged or already-published notes in read-only directories do not require write access. Restoring permissions permits completion.

Account-reader tests cover gateway-only bots with unavailable session-list routes, explicit/omitted empty default-session IDs, and independent long histories for multiple sessions. Each full-account scan checks inventories before and after its reads. A change to an earlier bot during a later bot's read retries the whole account; persistent changes exhaust bounded retries.

An integration test runs the actual browser adapter, HTTP transport abstraction, normalizer, renderer, and publisher against authored fictional responses. It records coverage gaps, preserves bytes/mtimes on rerun, and preserves the archive on later access failure. Other tests reject inconsistent coverage metadata and verify every recovered file against the intended bytes after interrupted publication.

The standalone binary checks cover argument handling, disabled configuration autoload, native lock initialization, preservation of a conflicting manifest, and the documented unsupported runtime overrides. They do not perform a live export. Publication-check regressions cover a secret left in the index after cleaning its working copy, force-added ignored files, renamed exported notes, and nested ignore rules.

`bun scripts/validate-browser-source.ts` is a separate opt-in live check. It runs the same account reader with a fresh browser sign-in and prints aggregate counts only. It does not write an archive or persist credentials.

## Export policy and service limits

Publication requires two matching full-account scans, with unverified additional-session inventories explicitly reported. Notes and `_export.md` use `coverage: observed-retained-history`; the CLI reports the number of unverified inventories. The manifest records affected bot IDs and names, session IDs, raw/text/exclusion counts, page termination, and the two-scan evidence. It does not claim atomic completeness.

These service limits remain:

1. A gateway-only box bot may have readable default history while its central session-list route returns HTTP 404. Successful or empty lists also lack a verified guarantee that every retained session is represented.
2. The inspected history response contains rows and generation, without an immutable snapshot handle or source-wide update boundary. Equal scans provide observational evidence; transient changes between reads can escape detection.
3. Retention/termination semantics, live long histories, blob/omitted bodies, group/peer authors, sleeping boxes, and absent/empty accounts need broader source validation. Unsupported storage/participant shapes fail visibly.

`inventoryComplete` and `retentionBoundaryVerified` remain false. Failed discovered-history reads, unsupported rows, changing reads, and destination conflicts stop publication. There is no force flag or fixture/certificate override in the CLI. See the [source contract](source-contract.md) for protocol assumptions.

## Remaining release work

- Trace the final binary's network/file access during authenticated export; mocked transport and offline CLI checks do not establish this.
- Verify the exact artifact on macOS 13 and inspect Obsidian rendering.
- Complete signing, notarization, and distribution validation.
- Validate broader provider schemas before claiming every agent/session/participant type is supported.

The binary remains an unsigned development artifact with explicitly limited source-coverage guarantees.
