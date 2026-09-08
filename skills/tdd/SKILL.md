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

Prove each behavior with a failing test, make it pass, then verify the whole suite.

## Hard rules

- Run tests with `run_tests`. A test run through bash records no evidence and leaves the gate
  locked.
- Name one behavior at a time and keep `testFullName` and `files` identical through the whole cycle;
  `behavior` is a label and may change. A different test name or file set starts a new behavior,
  which drops GREEN and full-run evidence. Earlier behaviors stay required until a full run reaches
  `verified`, so renaming their tests makes verification fail with a missing RED test.
- `testFullName` is the exact Vitest full name: the describe names and the it name joined with
  single spaces, such as `outer inner works`. Not `outer > inner > works`. Pass an array when one
  behavior is proven by several small tests; every one must fail in RED and pass in GREEN.
- Give every test a unique full name inside its file. Two tests with the same full name in one file
  cannot be identified, so that file proves nothing.
- A skipped, todo, or deleted test never counts as evidence, in RED or in verification.
- The gate checks that a test failed, not that it was worth writing. The test must fail because the
  behavior is missing. A test that fails for any other reason, or that you weakened or rewrote to
  match the code, opens the gate and proves nothing.
- Editing a required test file after RED invalidates that proof until the behavior has reached
  GREEN. After GREEN, a focused pass accepts the amended file and the full run reports the test as
  edited after GREEN, so a reviewer can look at the diff.
- A load error is not RED. When the module under test does not exist yet, create it empty through
  bash first; see "A new module".
- Only `write` and `edit` may touch files. Every other file-touching tool is blocked in every phase,
  whatever path it names. `read`, `grep`, `find`, `ls`, `bash`, `run_tests`, and `commit` always
  pass, and `write` and `edit` are ungated outside the production globs, such as on documentation or
  on files outside the worktree.
- `package.json` and the vite and vitest configuration files are protected. Writes to them are
  blocked in every phase, including while the gate is off, because they decide how verification
  runs. Change them through bash.

## Procedure

1. Write the failing test first. Put it in a test file next to the code, and match the naming,
   assertions, and helpers of the tests already there. Import the module under test with a normal
   static import, even when it does not exist yet.
2. Call `run_tests` with `scope: "focused"`. The phase becomes `red` and production writes open. A
   pass here means the behavior already exists or the test is too weak, so rewrite the test.
3. Read the failure. The summary names the failing tests with worktree-relative paths; `details`
   carries the full report.
4. Make the test file final before the fix exists. Write the production signatures the test needs as
   stubs that throw, then run the repository's format, typecheck, and lint checks through bash, as
   its own instructions name them, but not its full test suite. Fix what they report in the test
   file, then call `run_tests` with `scope: "focused"` again, same arguments. The test still fails
   against the stubs, so this only renews RED. Every edit to the test file after GREEN costs a rerun
   and is reported on the full run, so formatting belongs here too. A test edit made after the fix
   exists but before GREEN needs the fix removed again; see below.
5. Implement only what the failure asks for, then call `run_tests` with `scope: "focused"` again. A
   pass moves the phase to `green`.
6. Finish with `run_tests` and `scope: "full"`. The phase becomes `verified` when every test passes
   and every recorded RED test still runs and passes. The summary counts the tests in the required
   files that never failed under the gate; each of them is a test that skipped this procedure.
7. Start the next behavior from `green` or `verified` by writing its test and proving RED again.

One behavior per cycle, and every `it` you add belongs to it. Prefer several small `it` blocks named
together in `testFullName` over one large test with many assertions. A test that passes on its first
run is not evidence for anything, so do not add `it` blocks you have not named.

### A new module

A test whose import cannot resolve fails at load, and a load error never counts as RED because no
test ran. `bash` is not gated, so create the missing production file empty before the first run. The
sequence:

1. Write the test with a static import of the module.
2. Create the production file empty through bash, for example
   `mkdir -p src/thing && : > src/thing/index.ts`.
3. Call `run_tests` focused. The named test fails with `is not a function` or an undefined export,
   and the phase becomes `red`.
4. Continue from step 3 of the procedure.

## Recover a locked phase

The phase is `locked` when no valid RED evidence stands. The `run_tests` summary carries a `Next:`
line for the cases it can name, and a blocked write states the recovery for that path. The common
ones:

- No test yet: write the failing test, then run focused.
- The required test file changed after RED and before GREEN: run focused again. While the test still
  fails, that proves RED again. If the fix already exists, so the test passes, remove the fix so the
  test fails, run focused for RED, then put the fix back. A test changed after GREEN needs none of
  this; a focused pass accepts it.
- A protected file such as `package.json` or the vitest config changed after RED: the proof is tied
  to those files, so prove RED again the same way.
- A required RED test is skipped or missing: restore it so it runs and passes.
- Duplicate full names: rename the tests so each full name is unique in its file.

Returning to an earlier behavior keeps its RED, so a focused pass there lands in `green`, not
`locked`, also after a verified full run. When a commit hook or formatter touches files after
verification, rerun `run_tests` with `scope: "full"` for the same behavior; the phase returns to
`verified` without a new RED. Only a behavior the gate has not seen starts the next task and drops
the spent REDs.

Use the `run_tests` summary and the block message to read the current state. `/tdd status` reports
the gate, the phase, and whether production writes are allowed, without naming the behavior.

## Turning the gate off

The gate turns itself off when no test runner resolves from the worktree. `/tdd off` turns it off
for this worktree, recorded in `.tau/state.json`, so it also holds in later sessions until
`/tdd on`. Both print a notice in every `run_tests` summary, but only the `/tdd off` case reaches
commit results, so a missing notice there does not mean the gate is on. Protected paths stay blocked
either way. Files outside the worktree are never gated. Ask the user before turning the gate off.

## Checklist

- Proved RED with a focused run, and the test failed on its own assertion, not at load.
- Ran the repository's format, typecheck, and lint checks before GREEN, so no test edit came after
  it.
- Kept the behavior, full name, and files unchanged through the cycle.
- Reached GREEN with a focused run, then `verified` with a full run.
- Reported the failure you saw before the fix and the passing run after it.

## See also

- `src/extensions/tdd/state.ts` defines the phases and what invalidates evidence.
- `src/extensions/tdd/guard.ts` defines which tools and paths the gate blocks.
- `src/extensions/tdd/config.ts` defines the test and production globs and the protected paths.
- `docs/adr/0004-skill-authoring-style.md`
