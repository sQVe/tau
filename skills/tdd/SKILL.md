---
name: tdd
description:
  Drive the red-green-verified cycle that Tau's `run_tests` tool enforces, including how to recover
  when the gate locks production writes. Covers the tool protocol, not how to design a test.
---

# TDD

## When to use

Use this skill when you change behavior in a repository where Tau's `run_tests` tool is available.
Tau blocks `write` and `edit` on production files until a failing test proves the behavior is
missing, so this cycle is the only way to reach the implementation.

## Goal

Prove each behavior with a failing test, make it pass, and verify the whole suite, so every
production edit is backed by recorded test evidence.

## Hard rules

- Run tests with `run_tests`. A test run through bash records no evidence and leaves the gate
  locked.
- Name one behavior at a time and keep `behavior`, `testFullName`, and `files` identical through the
  whole cycle. Any change starts a new behavior, which drops its RED, GREEN, and full-run evidence.
  Earlier behaviors stay required until a full run reaches `verified`, so renaming their tests makes
  verification fail with a missing RED test.
- `testFullName` is the exact Vitest full name: the describe names and the it name joined with
  single spaces, such as `outer inner works`. Not `outer > inner > works`.
- Give every test a unique full name inside its file. Two tests with the same full name in one file
  cannot be identified, so that file proves nothing.
- A skipped, todo, or deleted test never counts as evidence, in RED or in verification.
- The gate checks that a test failed, not that it was worth writing. The test must fail because the
  behavior is missing. A test that fails for any other reason, or that you weakened or rewrote to
  match the code, opens the gate and proves nothing.
- Editing a required test file after RED invalidates that proof.
- The gate never blocks reading, searching, bash, or `commit`. Files outside the production globs,
  such as documentation, are not gated either.
- `package.json` and the vite and vitest configuration files are protected. Writes to them are
  blocked in every phase, including while the gate is off, because they decide how verification
  runs. Change them through bash.

## Procedure

1. Write the failing test first. Put it in a test file next to the code, and match the naming,
   assertions, and helpers of the tests already there.
2. Call `run_tests` with `scope: "focused"`. The phase becomes `red` and production writes open. If
   the run passes instead, the behavior already exists or the test is too weak. Rewrite the test.
3. Read the failure. The summary names the failing tests with worktree-relative paths; `details`
   carries the full report. Implement only what the failure asks for.
4. Call `run_tests` with `scope: "focused"` again, same arguments. A pass moves the phase to
   `green`. Clean up now if the fix left duplication or an awkward name: a production edit after
   GREEN drops back to `red` with writes still open, so refactor and run focused again.
5. Finish with `run_tests` and `scope: "full"`. The phase becomes `verified` when every test passes
   and every recorded RED test still runs and passes.
6. Start the next behavior from `green` or `verified` by writing its test and proving RED again.

## Recover a locked phase

The phase is `locked` when no valid RED evidence stands. The tool's `next` field states the exact
recovery for the case at hand. The common ones:

- No test yet: write the failing test, then run focused.
- The required test file changed after RED: run focused again. It proves RED again while the test
  still fails. If the production fix already exists, so the test passes, save the fix, revert only
  the production change with `git stash push` or `git restore`, run focused to prove RED, then
  restore the fix and run focused again.
- A required RED test is skipped or missing: restore it so it runs and passes.
- Duplicate full names: rename the tests so each full name is unique in its file.

The footer shows the current phase and active behavior. `/tdd status` reports the same, plus whether
production writes are allowed.

## Turning the gate off

The gate turns itself off when no test runner resolves from the worktree. `/tdd off` turns it off
for this worktree, recorded in `.tau/state.json`, so it also holds in later sessions until
`/tdd on`. Both cases print a notice in every `run_tests` summary and in commit results. Protected
paths and writes outside the worktree stay blocked either way. Ask the user before turning the gate
off.

## Checklist

- Proved RED with a focused run, and the test failed because the behavior was missing.
- Kept the behavior, full name, and files unchanged through the cycle.
- Reached GREEN with a focused run, then `verified` with a full run.
- Reported the failure you saw before the fix and the passing run after it.

## See also

- `src/extensions/tdd/state.ts` defines the phases and what invalidates evidence.
- `src/extensions/tdd/guard.ts` defines which tools and paths the gate blocks.
- `src/extensions/tdd/config.ts` defines the test and production globs and the protected paths.
- `docs/adr/0004-skill-authoring-style.md`
