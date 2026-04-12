# ADR 0006: Workspace state namespacing

- Status: Accepted
- Date: 2026-04-12

## Context

- Extensions need isolated persisted state; no shared top-level keys.
- State must survive crashes, reloads, and concurrent writers without partial files.
- The format needs a version so later migrations can reject or evolve it deliberately.
- `tdd` and `commit` are reserved namespace names for first-party extensions.

## Options considered

- **Single shared JSON object with ad hoc keys.** Simple today; collisions and overwrites become
  likely.
- **One file per extension.** Clear isolation; splits related state across files and complicates
  atomic loading.
- **Single versioned envelope with namespaced top-level keys.** One file, explicit isolation, and a
  clean migration boundary.

## Decision

Persist workspace state in `.tau/state.json` as a single versioned envelope with per-namespace
top-level keys, and treat unknown schema versions as failures rather than silent migrations.

### Envelope shape

- `version` is required; current value is `1`.
- `namespaces` is required and maps namespace names to plain object payloads.
- Reject missing `version`, missing `namespaces`, or non-object `namespaces` as unsupported
  versions.

### Namespacing contract

- Each extension owns a top-level namespace key.
- Namespace keys form the extension contract boundary; no implicit sharing.
- Reserve `tdd` and `commit` for first-party extensions.

### Migration policy

- v1 has no automatic migrations.
- Fail loudly on unknown versions so callers never read stale data as current.
- Defer the v2 migration strategy; document it before landing.

## Tradeoffs

- Isolation is explicit, not implied.
- The envelope provides one atomic write target.
- Cost: stricter schema quarantines or rejects malformed state instead of partially interpreting it.
- Cost: future migrations need an explicit plan instead of opportunistic field-by-field edits.

## See also

- [ADR-0001: Application structure](./0001-application-structure.md)
- [ADR-0002: File and directory naming conventions](./0002-file-naming-conventions.md)
