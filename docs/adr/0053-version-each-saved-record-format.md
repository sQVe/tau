# ADR 0053: Version each saved record format

- Status: Accepted; task record policy superseded by
  [ADR 0058](./0058-run-subagents-only-as-pi-workers.md)
- Date: 2026-09-27

## Context

- Worker records outlive the Tau that wrote them. An open session and a newer session can share one
  records folder (ADR 0045).
- Every record schema rejects unknown fields, so an older reader fails on any new field. An older
  session once refused every follow-up because a newer Tau had saved a name it rejected.
- Task records used `version` to name the worker kind, so it could not mark a format change.
- Tau has no releases. Sessions load Tau from a checkout, so "the previous release" names nothing.

## Options considered

For how long an older, running Tau must read records a newer Tau writes:

- One release back, so a newer Tau never writes a record the previous release cannot read. Rejected:
  every new field would need two releases, and Tau cuts no releases to test against.
- Until the older session restarts, best effort. Chosen: the older session skips what it cannot read
  and keeps working on everything else. A restart loads the newer reader.

For marking the format:

- Keep strict readers without a version. Rejected: a reader cannot tell a newer record from a broken
  one, so it can only report a failure with no fix.
- Accept unknown fields. Rejected: old readers would read records whose meaning changed, and act on
  them.
- Give each format its own version, and keep strict readers. Chosen: a reader can tell a newer
  record from a broken one, and it still rejects fields it does not know.

## Decision

Each saved record format has its own format version in a `version` field. The version names the
format only, never a worker kind or another value the reader can derive.

### Change the version with the format

- Any change to the saved fields is a format change, including a new optional field. A strict older
  reader rejects the new field, so the version must say why.
- Close an enumeration only when the reader branches on its value. Use an open, bounded pattern for
  values the reader only stores or displays, such as the worker name.

### State a policy for each version

Each format's reader sorts a record into one of four groups:

- Current: read as saved.
- Previous and supported: read, and treated as the current format in memory. A format stays
  supported while running Tau sessions may still own such records.
- Retired: skipped with a notice to start a fresh task.
- Newer: a version above the reader's current one. Skipped with a notice to restart the session.
  Follow-ups still read the claimed predecessor from it, so it keeps blocking a second follow-up of
  the same source.

A record that claims a known version but fails its schema is malformed. The reader reports it as a
diagnostic. No unreadable record may stop an operation that does not need it.

### Support older sessions until they restart

An older session reads newer records on a best-effort basis. It must not fail unrelated work, but it
may skip what it cannot read. Restarting the session is the supported fix.

### Write through `publishRecord`

Versioned formats are listed in `versionedRecords` and written only through `publishRecord`. A
structure test checks that each listed schema has a version literal and that no module writes a
listed file with plain `publish`. Other records move to this path when their format next changes.

### Test both directions

A change to a record writer keeps frozen fixtures, saved as files, for each supported version. Tests
read the previous and current fixtures with the current reader. They also check that a newer and a
malformed fixture are skipped without hiding other records. Task records, in
`src/extensions/subagents/fixtures/taskRecords/`, are the example to copy.

### Task records

Task record format 3 applies to both worker kinds. Versions 1 and 2 are the previous format and stay
supported. The earlier retired formats stay retired.

## Tradeoffs

- A newer record cannot break unrelated work in an older session, and its notice names the fix.
- Adding a field is a deliberate step with a version change and fixtures.
- Current code reads one format per record type. Older formats are converted where they are read.
- Cost: an older session does not show newer records until it restarts.
- Cost: every format change drops that record type from older sessions, even when the change only
  adds a field.
- Cost: most record types have no version yet. They keep failing closed until their next change.

## See also

- [ADR 0045: Keep worker records per Tau checkout and worktree files in `.tau/`](./0045-keep-worker-records-per-checkout-and-worktree-files-in-tau.md)
- [ADR 0052: Drop backwards compatibility by default](./0052-drop-backwards-compatibility-by-default.md)
