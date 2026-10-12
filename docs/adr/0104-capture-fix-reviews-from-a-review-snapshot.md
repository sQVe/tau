# ADR 0104: Capture fix reviews from a review snapshot

**Date**: 2026-10-12\
**Status**: Accepted\
**Extends**: [ADR 0089 (Capture review targets with a code_review tool)](./0089-capture-review-targets-with-a-code-review-tool.md)\
**Related**:
[ADR 0053 (Version each saved record format)](./0053-version-each-saved-record-format.md)

## Context

After a review closes its findings, the fix should get a review that covers the fix and its callers,
not the whole target again. A fix review needs the diff from the content the reviewer saw to the
current files.

A review of an uncommitted working tree has no commit for that content. Asking the user to commit
before each fix review would change their history to suit the tool.

## Decision

A `workingTree` or `files` capture copies the working tree content of each captured path into
`snapshot/` in the review directory. A new `fix` target diffs that snapshot against the current
files. A `range` or `rootCommit` capture needs no copy, since its pinned commit holds the content.

The `fix` target names the earlier review directory and the paths its findings cite. The capture
holds the diff of every path that changed, appeared, or disappeared since the earlier capture, and
`code_review` returns the fix paths, a `scope`, and the `outsidePaths`. The scope is `wholeTarget`
when the fix touches a path no finding cites. A pure function in `fixScope.ts` makes that decision.

`capture.json` moves to version 2. It holds the `fix` target and a snapshot manifest of the saved,
absent, and skipped paths. Binary, unreadable, and non-regular files are skipped and reported as
gaps. A fix capture refuses a version 1 record, a record with no snapshot, and a fix capture as its
base, and writes nothing.

## Consequences

### Positive

- A fix review works on uncommitted changes and leaves the user's history alone.
- The fix diff excludes everything the earlier review already covered.

### Negative

- A review directory holds a copy of the captured files until the directory is deleted.
- A fix review cannot use a version 1 review. The user captures that review again.
- A fix capture cannot be the base of another fix capture.

## Alternatives considered

### Diff against a commit

The skill would commit the reviewed state and diff the fix against that commit. Rejected because it
needs a commit for every review of an uncommitted change.

### Diff against a stash or temporary Git object

The tool would write the reviewed state as a Git object. Rejected because the capture never changes
Git objects or the index.
