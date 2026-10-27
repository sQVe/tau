# ADR 0124: Publish review captures as immutable generations

**Date**: 2026-10-27\
**Status**: Accepted\
**Related**: [ADR 0053 (Version each saved record format)](./0053-version-each-saved-record-format.md),
[ADR 0089 (Review code in a skill with a code_review tool)](./0089-capture-review-targets-with-a-code-review-tool.md)

## Context

A review directory holds the capture that a review reads, and a later freshness check or evidence
read can run at any time. A review that relies on a capture needs that capture to stay the same. If
a later capture overwrites the record or the input, the evidence the reviewer read no longer matches
what is on disk.

A capture writes several files: the input, the captured patch, and the record. A crash or a failed
write can leave some of them new and some old. A reader then cannot tell which files belong
together.

## Decision

A review capture publishes one immutable generation, and one capture owns each review directory. The
owner claims the directory by creating the `capture` folder, and it refuses a directory that already
has that folder. The owner saves the original patch and input in that folder, reads the saved bytes
back, and writes `capture.json` last. The record names the saved artifacts by their Git blob hashes,
so a reader can check them. A working tree or files capture also saves a snapshot that a later fix
capture diffs against. The record names it by the Git blob hash of a manifest that lists the mode
and blob hash of each saved copy and the snapshot's absent and skipped paths.

A range or working tree capture with no gaps also records its endpoint: the tree a commit of the
reviewed content would have, and the base tree it starts from. A range names both trees. A working
tree capture lays its verified snapshot over the base tree in a temporary index. Before it publishes
the record, the capture checks the transition: the raw diff from the base tree to the endpoint tree
must list exactly the paths the saved patch shows, with the blob and mode the patch shows for each.
A mismatch fails the capture. The capture then writes a commit of the endpoint tree on its base and
points `refs/tau/review-captures/<review directory name>` at it, so `git gc` keeps both trees. The
record names that ref. A rollback deletes the ref only while it still points at the capture's
commit. A files, root commit, or fix capture, and any capture with gaps, records its endpoint as
unsupported or incomplete with the reasons, and otherwise works as before.

The identity of a completed capture is the Git blob hash of its saved `capture.json`. Reads never
change the saved files, apart from the Git objects the transition check reads. A read reports one of
five states: completed, legacy, incomplete, altered, or missing. Only a completed capture with the
expected identity counts as evidence. A read of a record with a complete endpoint checks that Git
still has both trees and runs the transition check against the saved patch again. A missing tree
makes the capture missing, and a transition that differs from the patch makes it altered. A
completed result names its endpoint status separately, so a capture with an unsupported or
incomplete endpoint still reads as completed. A version 3 record has no endpoint. Version 1 and
version 2 records saved no original artifacts, so they read as legacy and never count for strict
chains. The evidence read reports an altered or missing capture as a gap, and it refuses an
incomplete capture, which has no record to report. A fix capture refuses an earlier review in any of
those states.

A failed capture removes what it created and restores the live input. It leaves no record, so the
directory cannot be read as complete. The next step is a new review directory, not a retry in place.

## Consequences

### Positive

- A saved capture never changes after publication. Freshness and evidence reads keep the first
  bytes, so a reviewer can compare any later result with the capture it used.
- A reader can prove that the saved files match the record, and it names the file that differs.
- Two captures on one directory cannot both publish. At most one record matches its own artifacts.
- A complete endpoint lets a later step compare the reviewed content with a commit by its tree.

### Negative

- A crashed capture leaves the `capture` folder behind. The directory then needs a new review, and
  the old folder stays on disk until someone removes it.
- Every new capture needs a new review directory, so a repeated capture costs one `prepare` call.
- Old records read as legacy. Strict chains that need the original artifacts refuse them.
- Each complete capture adds a ref under `refs/tau/review-captures/`. Its objects stay until someone
  deletes the ref, and a deleted ref plus `git gc` turns the capture missing.

## Alternatives considered

### Overwrite the record on each capture

Each capture replaces `capture.json` and the input. Rejected because a later capture changes the
evidence that an earlier review read, and a crash between writes leaves files from two captures
together.

### Claim the directory with a lock file

A lock file would mark the directory while a capture runs. Rejected because a crashed process leaves
a stale lock that needs a timeout or manual removal. A created folder has the same crash outcome,
but the outcome is simple: a new review directory.

### Use the hash of the patch as the identity

The identity would be the hash of `capture/patch.diff`. Rejected because the record also holds the
target, the head, the gaps, and the input hash. A change to those fields must change the identity
too.
