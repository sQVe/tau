# ADR 0089: Review code in a skill with a code_review tool

**Date**: 2026-10-05\
**Status**: Accepted\
**Supersedes**: [ADR 0060 (Keep local code review in a skill)](./README.md#retired),
[ADR 0091 (Return review evidence from the code_review tool)](./README.md#retired),
[ADR 0104 (Capture fix reviews from a review snapshot)](./README.md#retired)\
**Related**: [ADR 0053 (Version each saved record format)](./0053-version-each-saved-record-format.md),
[ADR 0088 (Write skills in Markdown, with a guide, tools, and templates)](./0088-grow-skills-into-tools-and-templates.md)

## Context

Review judgment belongs in a skill that uses the worker tools. Reviews stay advisory, and no review
engine has to keep verdict state.

Capture, freshness, and evidence reads are mechanics. Shell in a skill has no tests, and the capture
has to handle revisions, untracked files, submodules, and symlinks. The tool owns these mechanics
and tests them.

A prototype review engine registered candidates and bound verdicts to fresh verifier tasks. Its
orchestration cost fell on every review. It proved which task saved a verdict, not whether the
verdict was right.

Reviewers must read the same bytes the parent captured. The parent must know whether the target
changed before it reports.

## Decision

Review stays in the `code-review` skill, also reached as `/code-review`. Tau has one `code_review`
tool for the mechanics. It prepares a review directory, captures the target, checks freshness,
returns review evidence, and captures fix reviews. The tool does not judge code, choose evidence for
the reviewer, or bind verdicts to workers.

### Review skill

- Findings are advice. They carry their evidence status as advice, not as mechanical proof.
- Fast review uses one fresh reviewer. It tries to disprove each finding before it reports it.
- Deep review uses one fresh finder, then one fresh checker. The checker tests each candidate and
  looks for omissions.
- The skill gathers the evidence once and passes it to the reviewers. Reviewer workers do not have
  the `code_review` tool, so the manager reads the evidence for them.

### Capture

- `prepare` creates a fresh review directory.
- A capture appends its bytes and gaps to `input.md` and writes `capture.json`. An empty capture
  writes nothing.
- `capture.json` is the capture's identity: the pinned target, its base, HEAD, and the hash of the
  captured content.
- A `workingTree` or `files` capture saves verified copies of its files in `snapshot/`. The saved
  copies must match the bytes in `input.md`. A copy that does not match is removed, and the capture
  fails.
- A failed capture attempts to roll back its writes.
- Skipped paths, such as unreadable or non-regular files, are reported as gaps.
- A `range` or `rootCommit` capture needs no copy, because its pinned commit holds the content.

### Freshness

- `freshness` recaptures the target and compares the content hash and HEAD with the record. Either
  change makes the capture stale.
- A successful recapture overwrites `recheck.diff` in the review directory.
- A failed recapture or HEAD read removes `recheck.diff`.
- The tool writes no other review file, except that `evidence` also recaptures in the same way.

### Evidence

- `evidence` returns facts and gaps for a saved capture in one shared result shape. The facts are
  the tests of the changed code, their sibling tests, the callers, and the rule and check files the
  input names.
- A `range` or `rootCommit` target reads source at its pinned commit. Other targets read the current
  files.
- A stale or incomplete capture, a cut list or body, an unreadable file, and a missing named path
  each appear as a gap. No gap is silently omitted.
- Evidence makes no review judgment. It does not choose rule excerpts, rank evidence, or give
  verdicts.
- Callers are found by relative import paths, one line at a time. Package imports and aliased paths
  are not found. A line that only holds an import inside a string can still count as a caller.

### Fix review

- A `fix` target names the earlier review directory and the paths its findings cite.
- The capture holds the diff of each path that changed, appeared, or disappeared since the earlier
  capture. The result gives the fix paths, a `scope`, and the `outsidePaths`.
- The scope is `wholeTarget` when the fix touches a path that no finding cites. Otherwise it is
  `fix`.
- The earlier capture must be a `workingTree` or `files` capture with a snapshot, or a `range` or
  `rootCommit` capture. A fix capture refuses a record in an older format, a record without a
  snapshot where one is needed, and a fix capture as its base.

## Consequences

### Positive

- Tests cover capture, freshness, evidence, and fix capture.
- Reviewers read one fixed capture, and the report says when the target changed.
- A fix review works on uncommitted changes and leaves the user's history alone.
- The fix diff excludes everything the earlier review already covered.

### Negative

- Tau maintains a review tool, its result shape, and a saved record format.
- Freshness covers only the captured target, not callers or rules outside it.
- Nothing enforces that a deep verdict came from a fresh checker.
- A review directory holds copies of captured files until the directory is deleted.
- Callers are found only by relative import paths, so some callers are missed.

## Alternatives considered

### Shell capture in the skill

Keep the capture, freshness, and evidence reads as shell in the skill. Rejected because the shell is
untested, and every edit to it risks a wrong capture.

### Bring back the review engine

Bring back the review engine with review tools, target snapshots, candidate registration, and
verdicts bound to fresh verifier tasks. Rejected because its orchestration cost falls on every
review, and it cannot prove a verdict true.

### Evidence scripts in each manager

Keep evidence gathering in each manager's codemode script. Rejected because the reads are untested,
and each script can read the wrong revision or drop files silently.

### A separate evidence tool

Add a separate evidence tool. Rejected because it would read the same capture record and repeat the
freshness check, so two tools would own one review directory.

### Diff a fix against a commit

The skill would commit the reviewed state and diff the fix against that commit. Rejected because it
needs a commit for every review of an uncommitted change.
