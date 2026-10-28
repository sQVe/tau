# ADR 0105: Queue full checks per repository and reuse checks by identity

**Date**: 2026-10-12\
**Status**: Accepted\
**Supersedes**: [ADR 0039 (Reuse reported checks and run one full suite per work state)](./README.md#retired)\
**Related**:
[ADR 0023 (Use advisory TDD observations instead of edit permissions)](./0023-advisory-tdd-observations.md),
[ADR 0053 (Version each saved record format)](./0053-version-each-saved-record-format.md),
[ADR 0094 (Compose PR publication evidence)](./0094-compose-pr-publication-evidence.md),
[ADR 0106 (Replay unchanged test projects in `pnpm check`)](./0106-replay-unchanged-test-projects-in-pnpm-check.md),
[ADR 0120 (Capability modules with an enforced import table)](./0120-capability-modules-with-an-enforced-import-table.md)

## Context

Several Pi sessions in different checkouts can run the same full check at the same time. The runs
compete for CPU and for shared resources, such as Docker ports, and they fail or slow each other
down. Checks also rerun on a state that already passed, including after a commit or amend that
changes no files. Workers report focused checks, and a repeated check on unchanged inputs adds no
evidence about them.

## Decision

### Full check queue and reuse

The `full_check` tool runs one full check at a time for each repository, and returns a saved passing
log when the state has not changed. Checks of different repositories run at once. One full check
runs per work state, at the PR step.

The tool takes a lock for the repository in the `tau/full-check` directory under the agent
directory. It waits while another checkout of that repository holds the lock. Full checks and
mutation checks of one repository share the lock, because they share resources such as Docker ports.
The lock file name comes from the lowercase `owner/name`, encoded so it holds no path separator.

The tool checks for a reusable log before it waits and again after it takes the lock. Another
session may have saved a matching log while this one waited.

### Full check identity

Each finished log gets a versioned record next to it in `.tau/checks`. The shared module
`src/checkRecord/` owns the record format and the full check identity, so the tools that read
records share one definition. The record holds the tree ID of the working state, the configured
`argv`, and whether the run passed. It names no commit and no base, so `full_check` takes no base.

The tree ID comes from Git. Tau stages every file Git does not ignore, untracked files included,
into a temporary copy of the index and writes the tree from it, so the real index stays unchanged.
Two states with the same files have the same tree ID, whatever their commits are. Tau stages with
mode tracking on and attribute conversions and filters off, so the raw bytes and mode of a changed
file form its entry. With a Git that cannot turn attributes off, a dirty submodule, or an active
rule in `.git/info/attributes`, the state has no tree ID and is never reusable.

The tool reads the identity before and after the run. It saves a record, passing or failing, only
when both identities are equal, so an edit during the run never gives a reusable log.

Reuse looks at the valid records for the tree ID that have an existing log, newest first. The newest
one decides. The tool reuses its log only when that record passed with the same command. Otherwise
the check runs again. Malformed records and records without a log are skipped, so an older valid
pass for the same tree still counts. The new run saves a newer record, so a reader of the newest
record, such as the `pr` tool, sees the latest result.

The reuse rule is a pure function that takes the records and the current identity as facts.

The record is the only identity of a full check. The `pr` tool's `evidence` action reads it for the
published tree with the configured command, and reports it as passed, failed, missing, or malformed.
A newest record of another command reads as missing. The full check log carries no header lines. A
`run_tests` result does not replace this record.

### Other check identity

Other checks have a header identity instead of a record. Their log starts with three lines:
`HEAD: <sha>`, `Status: <hash>`, and `Diff: <hash>`. Status and diff hashes use SHA-256 over the
exact output bytes of `git --no-optional-locks status --porcelain` and
`git diff --no-ext-diff --no-textconv --no-color <mergeBase> HEAD`, including trailing newlines.
Disabling optional locks keeps status from refreshing the index. Disabling external diff helpers,
text conversion, and color keeps those settings out of the check identity.

The `pr` tool's read-only `checkHeader` action produces the lines. A caller asks for them and saves
them before its check. Header production and evidence matching share one reader, so byte handling
and Git output limits cannot drift. Explicit byte hashing avoids shell whitespace changes and works
independently of Git's object format. A missing or malformed header, or an unavailable current
identity, cannot establish a match.

The two identities have separate owners. `src/checkRecord/` owns the full check identity: the tree
ID and the exact `argv`. `src/extensions/pr/evidence.ts` owns the header identity.

### Rerun reasons

Reuse a reported check whose identity matches the current work state. A reported check is evidence
for the state it names, not proof that the change is correct. Do not infer that an unrun check
passed, or that an old result covers changed inputs. Review supplies the correctness check: it reads
the test diff before the implementation diff, inspects the actual source, and verifies a suspected
finding without running the full suite again.

Repeat a check only for a concrete reason:

- relevant changes since the check;
- missing or contradictory evidence that running the check must resolve;
- a targeted reproduction of a defect;
- an integration change;
- an explicit mandatory gate, such as a Git hook, CI, or a user request.

Use the smallest check that resolves the reason. A new session, another model, or an absent
session-local observation is not a reason to repeat a check.

## Consequences

### Positive

- Concurrent checks in one repository do not collide on shared resources.
- A short check of one repository does not wait behind a long check of another.
- A second call for an unchanged state costs no run.
- One full suite at the PR step satisfies the repository gate on the same inputs.

### Negative

- A check that reads state outside the checkout, such as the network or a database, can pass again
  with different results. Reuse hides that change.
- Checks of different repositories compete for CPU. No limit applies across repositories.
- Git keeps the stored blob of a tracked file whose stat data did not change. When a normalizing
  rule, such as `*.txt text eol=lf`, made that blob differ from the file's bytes, a later edit to
  those same bytes, such as a switch between CRLF and LF, keeps the tree ID. A check that reads raw
  bytes can then reuse a stale pass.
- Git does not restage a file marked assume-unchanged or skip-worktree, so an edit to it keeps the
  tree ID.
- A record names no commit. A reader of a saved log learns the files it covered, not the commit it
  was made on.
- Callers must save the exact header before running a check to make its log reusable.
- Porcelain status describes paths and states, not dirty file contents. Its hash cannot detect every
  edit to a file that was already dirty.
- A dishonest or mistaken report is not detected by a second run of the same command.
- Reuse relies on agents naming the work state a check covered and disclosing later edits.

## Alternatives considered

### Reuse a log by commit only

Match on the head commit alone. Rejected because uncommitted edits and a changed base or command
would return a log for a different state.

### Key full check reuse by the head, the base, and a hash of the changes

Rejected because it reran passing checks on unchanged files after a commit, an amend, or a base
move, and it required every caller to pass the base.

### Hash every file raw from an empty index

Build the temporary index from nothing, so no stored blob hides a change. Rejected because it hashes
the whole tree on each call.

### Match other checks by head or timestamp only

Treat a recent log or an equal head as sufficient. Rejected because neither records worktree status
or the branch diff against the selected merge base.

### Compute headers in the skill

Give the skill scripts that hash Git output. Rejected because they duplicate the reader's mechanics
and can use different output limits, failing on diffs the evidence reader can handle.

### Machine-wide lock

Queue every check on the machine behind one lock. Rejected because the wait behind checks of other
repositories cost more than the contention it removed.

### A machine-wide limit on concurrent checks

Allow a fixed number of checks at once across all repositories. Deferred until check timeouts caused
by CPU contention show up.
