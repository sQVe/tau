---
name: tdd
description:
  Use Tau's run_tests tool for failing focused tests and passing focused tests. Verify the full
  suite with the repository full check or run_tests. Use when changing behavior. Covers the tool
  protocol, not test design.
---

# TDD

## When to use

Use this skill when changing behavior where `run_tests` is available. Start with a failing test,
make it pass, then verify the whole suite through the repository's full check or one full
`run_tests` run.

## Principles

- RED and GREEN describe observed test results, not permission to edit.
- Use `run_tests` so Tau can report outcomes and suggest the next step. Bash test runs do not update
  these session-local observations.
- Give each test a unique full name within its file. Duplicate, skipped, missing, and load-error
  tests cannot establish RED.
- Read why a test failed. A failure does not prove that the assertion is useful. Do not weaken an
  assertion just to make the implementation pass.
- Hints never block work or need acknowledgment. Git hooks and comment review remain separate from
  TDD observations.

## Procedure

1. Write a failing test next to the code. Import the production module normally. If it does not
   exist, create an empty module so an unresolved import is not mistaken for RED.
2. Call `run_tests` with `scope: "focused"`. Follow the tool description for the exact selection
   format. Do not restructure tests or broaden selection to make the tool run.
3. Read the failure summary and the runner report in `details`. Implement the change, then rerun
   focused with the same files and names. The label can change without changing test selection.
4. Refactor and format as needed. Before handing off, run the repository's full check, such as
   `pnpm check`, or reuse a qualifying current reported full check for the same inputs. One pass on
   the current inputs satisfies full verification; do not rerun an equivalent full suite for
   bookkeeping, and do not rerun only because you are about to hand off. Mandatory hooks and CI
   still run on their own. A full `run_tests` pass also counts when no repository check will run.
5. Report the outcome and freshness separately. `stale` means tracked inputs changed; `unknown`
   means Tau could not read them. The actual runner report remains available in both cases. Rerun
   tests on the current inputs before claiming current verification.

Tau keeps one active behavior per session and directory, not a history of RED coverage. A full pass
starts the next cycle. External edits are detected only at test and write/edit/bash result
checkpoints. These content checks are not atomic snapshots.
