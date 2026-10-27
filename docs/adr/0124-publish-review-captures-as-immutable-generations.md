# ADR 0124: Publish review captures as immutable generations

**Date**: 2026-10-27\
**Status**: Accepted\
**Related**: [ADR 0053 (Version each saved record format)](./0053-version-each-saved-record-format.md),
[ADR 0089 (Capture review targets with a code_review tool)](./0089-capture-review-targets-with-a-code-review-tool.md),
[ADR 0104 (Capture fix reviews from a review snapshot)](./0104-capture-fix-reviews-from-a-review-snapshot.md)

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

The identity of a completed capture is the Git blob hash of its saved `capture.json`. Reads never
change the saved files. A read reports one of five states: completed, legacy, incomplete, altered,
or missing. Only a completed capture with the expected identity counts as evidence. Version 1 and
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

### Negative

- A crashed capture leaves the `capture` folder behind. The directory then needs a new review, and
  the old folder stays on disk until someone removes it.
- Every new capture needs a new review directory, so a repeated capture costs one `prepare` call.
- Old records read as legacy. Strict chains that need the original artifacts refuse them.

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
