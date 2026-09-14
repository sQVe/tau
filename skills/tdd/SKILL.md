---
name: tdd
description:
  Use Tau's run_tests tool for failing focused tests, passing focused tests, and full verification.
  Use when changing behavior. Covers the tool protocol, not test design.
---

# TDD

## When to use

Use this skill when changing behavior where `run_tests` is available. Start with a failing test,
make it pass, then run the whole suite.

## Principles

- RED and GREEN describe observed test results, not permission to edit.
- Use `run_tests` so Tau can report outcomes and suggest the next step. Bash test runs do not update
  these session-local observations.
- Give each test a unique full name within its file. Duplicate, skipped, missing, and load-error
  tests cannot establish RED.
- Read why a test failed. A failure does not prove that the assertion is useful. Do not weaken an
  assertion just to make the implementation pass.
- Hints never block work or need acknowledgment. Commit checks and approval remain separate.

## Procedure

1. Write a failing test next to the code. Import the production module normally. If it does not
   exist, create an empty module so an unresolved import is not mistaken for RED.
2. Call `run_tests` with `scope: "focused"`, a `behavior` label, literal worktree-relative `files`,
   and `testFullName`. Use the exact Vitest full name: describe names and the test name joined with
   spaces, such as `outer inner works`. An array selects several names for one behavior.
3. Read the failure summary and the runner report in `details`. Implement the change, then rerun
   focused with the same files and names. The label can change without changing test selection.
4. Refactor and format as needed. Call `run_tests` with `scope: "full"` before handing off. A full
   pass counts without prior RED or a renewed focused run after formatting.
5. Report the outcome and freshness separately. `stale` means tracked inputs changed; `unknown`
   means Tau could not read them. The actual runner report remains available in both cases. Rerun
   tests on the current inputs before claiming current verification.

Tau keeps one active behavior per session and directory, not a history of RED coverage. A full pass
starts the next cycle. External edits are detected only at test and write/edit/bash result
checkpoints. These content checks are not atomic snapshots.
