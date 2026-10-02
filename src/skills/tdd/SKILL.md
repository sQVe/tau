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
make it pass, then verify the whole suite once.

## Hard rules

- RED and GREEN name observed test results. They do not give permission to edit.
- Run tests with `run_tests` so Tau can report outcomes and suggest the next step. Bash test runs do
  not update these session observations.
- Give each test a unique full name within its file. Duplicate, skipped, missing, and load-error
  tests cannot establish RED.
- Read why a test failed. A failure does not prove that the assertion is useful. Do not weaken an
  assertion just to make the implementation pass.
- Hints never block work or need a reply. Git hooks run separately from TDD observations.

## Procedure

1. Write a failing test next to the code. Import the production module normally. If it does not
   exist, create an empty module so an unresolved import is not mistaken for RED.
2. Call `run_tests` with `scope: "focused"` and the selection format from the tool description. Do
   not restructure tests or broaden the selection to make the tool run.
3. Read the failure summary and the runner report in `details`. Implement the change, then rerun
   focused with the same files and names. You can change the label; keep the selection.
4. Refactor and format as needed. Before handing off, verify the full suite once:
   - Run the repository's full check, such as `pnpm check`, or reuse a current reported full check
     on the same inputs.
   - A full `run_tests` pass also counts when no repository check will run.
   - One pass on the current inputs is enough. Do not rerun an equivalent full suite for bookkeeping
     or because you are about to hand off. Required hooks and CI still run on their own.
5. Report the outcome and the freshness as separate facts.
   - `stale` means tracked inputs changed. `unknown` means Tau could not read them. The runner
     report stays available in both cases.
   - Rerun tests on the current inputs before you claim current verification.

Tau keeps one active behavior per session and directory, not a history of RED results. A full pass
starts the next cycle. Tau detects external edits only when a test run or a write, edit, or bash
call returns. These content checks are not atomic snapshots.
