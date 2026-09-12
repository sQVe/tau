---
name: tdd
description:
  Follow the red-green-verified cycle enforced by Tau's `run_tests` tool. Use when changing behavior
  or recovering from blocked production writes. Covers the tool protocol, not test design.
---

# TDD

## When to use

Use this skill when changing behavior in a repository where Tau's `run_tests` tool is available.
Prove each behavior with a failing test, make it pass, then verify the whole suite.

## Hard rules

- Run tests with `run_tests`. A test run through bash records no evidence and cannot open the gate.
- Keep `testFullName` and `files` the same through the cycle. `behavior` is a label and may change.
- Use the exact Vitest full name: describe names and the it name joined with spaces, such as
  `outer inner works`. Pass an array when several small tests prove one behavior together. Every
  named test must fail in RED and pass in GREEN.
- Give every test a unique full name inside its file. Skipped, todo, deleted, and load-error tests
  never count as evidence.
- Check why the test failed. The gate cannot judge whether an assertion is useful or whether an edit
  weakened it. Do not change an assertion just to make the implementation pass.
- Use `write` and `edit` with literal paths. Unrecognized tools are blocked; bash is exempt. `.tau/`
  and [protected configuration paths](../../src/extensions/tdd/config.ts) stay blocked even with the
  gate off. Change configuration through bash.

## Procedure

1. Write the failing test next to the code, following the repository's conventions. Import the
   module normally. If it does not exist, create it with `write` and `content: ""`. Only a new,
   empty production file is allowed before RED. An unresolved import is not RED.
2. Call `run_tests` with `scope: "focused"`, `behavior`, `testFullName`, and `files`. Read the
   failure in the summary and the full report in `details`. A qualifying failure stores `red` and
   opens production writes. A pass without prior RED does not prove the behavior.
3. Implement only what the failure asks for. Run the repository's format, typecheck, and lint
   commands as required. If a test file changes, review the edit and rerun focused with the same
   names and files. A qualifying failure stores fresh RED; a qualifying pass accepts the edit and
   stores `green`.
4. Clean up after GREEN, then rerun focused tests. GREEN permits production writes, but changed
   production, tests, or configuration invalidate the passing result.
5. Call `run_tests` with `scope: "full"`. It reaches `verified` only when every recorded RED test
   runs and passes, and its verification inputs match an accepted focused snapshot.
6. Read the full run's coverage line and review tests marked "edited after RED". The committed-title
   count is an estimate from source text, not proof that an assertion existed or stayed unchanged.
7. Start the next behavior by writing its test and proving RED again. After formatting or a commit
   hook changes the verified tree, rerun full verification for the same behavior.

## Phases and recovery

The [evidence store](../../src/extensions/tdd/state.ts) defines the phase transitions. Reads check
file changes without rewriting the stored phase:

- `locked`: write a failing test and run focused. A test file edited in RED locks production writes
  until another qualifying focused run. A focused pass accepts that edit without removing the fix.
- `red`: implement the behavior, then run focused to reach GREEN.
- `green`: cleanup is allowed. Rerun focused after edits, then run full.
- `verified`: the full run passed with every recorded RED present and passing. A production, test,
  or configuration change reports GREEN until verification passes again.

Returning to a known behavior restores its stored focused phase. Earlier REDs stay required until a
new behavior starts after the stored phase reaches `verified`. Do not rename or delete those tests
to make verification pass.

Use `/tdd status`, blocked-write messages, and the summary's `Next:` line for recovery:

- Inputs changed during the run: stop concurrent edits and rerun.
- Duplicate full names: rename the duplicates so each test can be identified.
- Missing or skipped RED: restore that test so it runs and passes.
- Stale verification inputs: rerun focused for the affected recorded behaviors, then rerun full. A
  shared test file uses its latest accepted focused snapshot. Configuration changes require renewing
  every affected RED.
- Dangling symlink: repair it before writing. The guard cannot classify a missing target safely.

## Turning the gate off

The gate turns itself off when no test runner resolves from the worktree. `/tdd off` turns it off
for this worktree, recorded in `.tau/state.json`, until `/tdd on`. Both cases print a notice in
`run_tests` summaries and commit results. Protected paths stay blocked either way. Ask the user
before turning the gate off.
