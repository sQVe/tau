# ADR 0019: Verify backups before hiding working edits

**Date**: 2026-09-10\
**Status**: Superseded\
**Superseded by**:
[ADR 0025 (Use Git hooks without preparation)](./0025-use-git-hooks-without-preparation.md)\
**Related**: [ADR 0016 (Prepare each commit with separate staging)](./0016-staged-preparation-ownership.md),
[ADR 0020 (Run staged checks in the existing checkout)](./0020-checks-in-the-existing-checkout.md),
[ADR 0021 (Prune recovery snapshots after verified restoration)](./0021-prune-verified-recovery.md)
replaces the retention rule

## Context

Future checks should run against staged files in the existing checkout, keeping installed
dependencies available. That requires temporarily hiding unrelated working edits. Before files can
change, Tau needs a reliable backup and clear rules for when restoration is safe.

## Decision

Tau must save and verify a backup before temporarily removing working edits. Backing up exact
working bytes and staging, then restoring only under recorded conditions, keeps exact bytes,
permissions, and staging, and restores only when that is safe.

The backup must survive Tau stopping unexpectedly. Preserve exact working bytes, file permissions,
and staging, including content that exists only in the staging area.

Restore only when HEAD and staging remain unchanged and working files match either the complete
original state or the complete expected state with unrelated edits removed. This foundation does not
change or restore staging. Preserve unexpected work rather than merge or overwrite it.

Partial changes, interrupted recovery, or ambiguous conditions require manual inspection. Keep
backups and block further commits while recovery is pending, even if backup creation stopped before
files changed. Retain recovery copies after success: deleting them could discard user work written
to displaced files.

This decision establishes recovery requirements. Running checks in the existing checkout will be a
separate change. It does not yet hide edits or change existing preparation recovery.

## Consequences

### Negative

- Exact backups cost storage and verification work.
- Refusing uncertain restoration requires manual recovery and manual removal of old backups.
- Support is limited to local POSIX checkouts with supported files and indexes, bounded working
  data, and stopped writers. It does not protect against every concurrent write or filesystem
  failure.

## Alternatives considered

### Stash

Use a stash. Rejected because restoring through a merge can conflict or change staging.

### Restore through Git checkout

Restore through Git checkout. Rejected because Git can convert file bytes and cannot preserve all
file permissions.
