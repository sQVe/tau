---
name: tdd
description:
  Change behavior test-first with Tau's run_tests tool, then verify with one full check and a
  mutation check. Use it when changing behavior. Covers the cycle and survivor handling, not test
  design.
---

# TDD

Use this skill when you change behavior and `run_tests` is available.

## Hard rules

- Run tests with `run_tests`, not bash, so Tau observes RED and GREEN. They are observations, not
  permission to edit.
- Give each test a unique full name within its file. Duplicate, skipped, missing, and load-error
  tests cannot establish RED.
- Read why a test failed. A failure does not prove the assertion is useful. Do not weaken an
  assertion to make the code pass.
- Hints never block work. Git hooks and CI still run, separately from TDD observations.

## Procedure

1. Write a failing test next to the code, importing the production module normally. If the module
   does not exist, create it empty, so an unresolved import is not taken for RED.
2. Call `run_tests` with `scope: "focused"`. Do not restructure tests or widen the selection to make
   the tool run.
3. Read the runner report. Implement the change. Rerun focused with the same files and names until
   it passes. You may change the label, but keep the selection.
4. Refactor and format. Then verify the whole suite once: with `full_check`, with the repository's
   own check when it has no `full_check` entry, or with a full `run_tests` pass when no repository
   check will run. One pass on the current inputs is enough. Do not rerun an equivalent suite.
5. After the full check passes, run `mutation_check` with `mode: "changed"` and no `base` once. Skip
   this step, and say so, when the repository has no `mutation.argv`. Report a tool error on its own
   line and stop the step. Survivors are advice. Fix at most 3 behaviors in one round: write a test
   that kills the survivor, or simplify redundant code it points at. After that round, rerun the
   full check and `mutation_check` at most once. Then list what is left as open, with file and line.
   Give no reason per mutant.

   Place a killing test in the owner's existing behavior test file, or add a row to its decision
   table. When the owner has no test file yet, use its normal test file next to it, as step 1 says.
   Never name a test file after a campaign or a test technique, such as `mutationKills.test.ts` or a
   slice name. Write no test for a survivor in wording, layout text, or transport encoding that no
   caller can observe. List it with the other open survivors, with no reason. It does not count
   toward the limit of 3 behaviors.

6. Report the test outcome and its freshness as separate facts. When the freshness is `stale` or
   `unknown`, rerun on the current inputs before you claim current verification.

Tau keeps one active behavior per session and directory. A full pass starts the next cycle. Tau
detects external edits only when a test run or a write, edit, or bash call returns. These checks are
not atomic snapshots.
