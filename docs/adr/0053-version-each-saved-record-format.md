# ADR 0053: Version each saved record format

**Date**: 2026-09-27\
**Status**: Accepted\
**Related**: [shared ADR 0008 (Drop backwards compatibility by default)](../stomme/shared/adr/0008-backwards-compatibility.md)

## Context

Worker records outlive the Tau that wrote them. An open session and a newer session can share one
records folder ([ADR 0043](./README.md#retired)).

Task records used `version` to name the worker kind, so it could not mark a format change. Tau has
no releases. Sessions load Tau from a checkout, so "the previous release" names nothing.

## Decision

Tau's saved records follow [shared ADR 0008](../stomme/shared/adr/0008-backwards-compatibility.md):
each format has its own `version` field, readers stay strict, and each reader sorts a record into
current, previous and supported, retired, or newer. The sections below state what is Tau's own.

### Version only records that Tau reads back

A saved file counts as a record when Tau code parses it again, in this session or a later one. A
write-only diagnostic file that no Tau reader parses, such as the `run.json` of a TDD run, needs no
version or fixtures. Its readers are people and agents who inspect it. Once Tau code starts to read
such a file, it becomes a record and gets a version with that change.

### Keep a record's values open when the reader does not branch

Close an enumeration only when the reader branches on its value. Use an open, bounded pattern for
values the reader only stores or displays, such as the worker name.

### Support older sessions until they restart

An older session reads newer records on a best-effort basis. It must not fail unrelated work, but it
may skip what it cannot read. Restarting the session is the supported fix.

### Write through `src/record.ts`

`src/record.ts` is the one path for versioned records. It parses and writes them, and it holds the
synchronous publish and bounded read that worker records use. Versioned worker formats are listed in
`versionedRecords` and written only through `publishRecord`. Other records move to this path when
their format next changes.

### Test both directions

A change to a record writer keeps frozen fixtures, saved as files, for each supported version. Tests
read the previous and current fixtures with the current reader. They also check that a newer and a
malformed fixture are skipped without hiding other records. Assignment records, in
`src/extensions/subagents/fixtures/assignment/`, are the example to copy. A structure test checks
that each schema in `versionedRecords` has a version literal and that no module writes a listed file
with plain `publish`.

## Consequences

### Positive

- A newer record cannot break unrelated work in an older session, and its notice names the fix.
- Each record type states which versions its reader supports, so a reader never guesses.

### Negative

- An older session does not show newer records until it restarts.
- Most record types have no version yet. They keep failing closed until their next change.

## Alternatives considered

### Read records one release back

Require an older, running Tau to read records a newer Tau writes one release back, so a newer Tau
never writes a record the previous release cannot read. Rejected because every new field would need
two releases, and Tau cuts no releases to test against.
