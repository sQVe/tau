# ADR 0015: Ask before adding generated files

- Status: Proposed
- Date: 2026-09-10

## Context

Preparation is a command configured by the repository in `tau.json` that may format or generate
files. Its output can include files outside the planned commit. A file with no prior edits is not
necessarily a file the user wants to commit.

## Options considered

- Always stop and require a new commit tool call. Safe, but interrupts users who can decide
  immediately.
- Add generated files automatically. This confuses generated output with permission to commit it.
- Ask before including generated files. Keeps the choice explicit without repeating preparation.

## Decision

Require explicit assignment before checks and review: the user chooses whether preparation-generated
files belong in the current commit. Commit approval is a separate decision covering all selected
changes. Assigning files does not approve the commit or waive review.

Ask for assignment during interactive calls, where Pi can prompt the user. Never include preexisting
unrelated edits or files planned for another commit, even if preparation changes them. The commit
tool still rejects sensitive files.

Each prepared commit requires approval unless the user chose startup preapproval by starting Pi with
commit confirmation disabled. Do not offer approval of all remaining prepared commits at once.
Startup preapproval cannot authorize undiscovered files: stop on additions for inspection and
explicit assignment in a new commit tool call.

Keep the separate staging and backup decision in [ADR 0014](./0014-staged-preparation-ownership.md).

## Tradeoffs

Interactive users make two decisions: which files belong together, then whether to commit them.
Unattended calls stop when preparation produces unassigned files rather than guessing the user's
intent.
