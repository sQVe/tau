---
name: tdd
description:
  Drive the red-green-verified cycle that Tau's `run_tests` tool enforces, including how to recover
  when the gate locks production writes. Covers the tool protocol, not how to design a test.
---

# TDD

## When to use

Use this skill when you change behavior in a repository where Tau's `run_tests` tool is available.
Prove each behavior with a failing test, make it pass, then verify the whole suite.

## Phases

The phase is what the last `run_tests` call stored, initially `locked`:

- `locked`: no valid RED authorizes production writes.
- `red`: a focused run proved the named tests fail.
- `green`: the tests recorded in RED passed in a focused run.
- `verified`: the full suite passed with every recorded RED test present, passing, and its file
  hashes accepted.

Only two byte checks can change the phase reported by a read:

- In `red` or `green`, changed test files belonging to the active RED report `locked`, with the
  changed files in `staleSinceRed`. The stored entry stays, so a later focused run can renew it.
- In `verified`, a changed tree digest reports `green`. The digest covers production and test files,
  required files, and verification configuration.

Reads do not rewrite the stored phase. With the gate on, production writes under the configured
globs open only in stored `red` while the active RED's test files still match. Protected paths stay
blocked in every phase.

The next focused pass renews a test edited before GREEN and reports the edit on the full run instead
of leaving the phase locked. A production edit through bash after GREEN does not reopen the gate.

## Hard rules

- Run tests with `run_tests`. A test run through bash records no evidence and cannot open the gate.
- Keep `testFullName` and `files` identical through the cycle; `behavior` is a label and may change.
  A new test name or file set starts an unseen behavior in `locked`. Returning to a known behavior
  restores its stored focused phase before applying the run's result. Earlier REDs remain required
  until an unseen behavior starts after stored `verified`.
- `testFullName` is the exact Vitest full name: describe names and the it name joined with single
  spaces, such as `outer inner works`. Pass an array when several small tests prove one behavior;
  every named test must fail in RED and pass in GREEN.
- Give every test a unique full name inside its file. Duplicate names make that file ambiguous.
  Skipped, todo, deleted, and load-error tests never count as evidence.
- The test must fail because the behavior is missing. The gate cannot judge whether the assertion is
  useful or whether an edit weakened it.
- Use `write` and `edit` with literal paths. They are ungated outside the production globs, except
  for protected paths. Unrecognized tools are blocked in every phase; bash is exempt.
- `.tau/`, `package.json`, and the protected vite and vitest configuration paths stay blocked even
  with the gate off. Configuration changes must go through bash.

## Procedure

1. Write the failing test next to the code, following the repository's test conventions. Import the
   module normally. If it does not exist, create it empty through bash before running the test, for
   example `mkdir -p src/thing && : > src/thing/index.ts`. An unresolved import is not RED.
2. Call `run_tests` with `scope: "focused"`, `behavior`, `testFullName`, and `files`. Read the
   failure in the summary and the full report in `details`. A qualifying failure stores `red` and
   opens production writes. A pass without prior RED cannot prove the behavior.
3. Implement only what the failure asks for. Run the repository's format, typecheck, and lint
   commands as required. If a test file changes, rerun focused with the same names and files; a
   qualifying failure stores fresh RED, and a qualifying pass accepts the edit and stores `green`.
4. Call `run_tests` focused after the fix to reach `green`, then with `scope: "full"` to reach
   `verified`. Full verification requires every recorded RED test to run and pass, and required file
   hashes to match the latest RED in that file. If a test file changed, run its behavior focused
   before retrying full verification.
5. Read the full run's coverage line, which counts tests in the required files that were "proven RED
   or committed before". It names new tests that "never failed" and proven tests in amended files as
   "edited after RED". Review those edits; a passing run does not prove they kept the original
   assertion.
6. Start the next behavior by writing its test and proving RED again. After a formatter or commit
   hook changes the verified tree, rerun full verification for the same behavior.

## Read recovery messages

`/tdd status` reports the gate, phase, and whether production writes are allowed. The
[write guard](../../src/extensions/tdd/guard.ts) names the path, phase, active behavior, and next
step. For example, before any behavior is active:

```text
Blocked src/thing.ts in phase locked, active behavior: none. Write a failing test with write using path "src/thing.test.ts" and content that checks the missing behavior.
```

With an active behavior, a locked write asks you to prove RED with a focused call. In `green`, it
asks for full verification or the next behavior's RED; in `verified`, it asks for the next test. An
edited active test file can lock a read, but a focused pass accepts it without removing the fix.

The [run_tests summary](../../src/extensions/tdd/index.ts) includes `Next:` when it can name a
recovery. A focused pass without prior RED gives this guidance for an example behavior:

```text
Next: The test does not fail yet; the behavior may already be implemented. Write a test that fails before the fix, then call run_tests {"behavior":"thing works","testFullName":"thing works","files":["src/thing.test.ts"],"scope":"focused"}.
```

Other guidance names concurrent input changes, duplicate full names, or skipped or missing RED
tests. Stop concurrent edits and retry; give duplicates unique names; restore required tests so they
run and pass. A full run cannot verify missing or ambiguous RED tests.

## Turning the gate off

The gate turns itself off when no test runner resolves from the worktree. `/tdd off` turns it off
for this worktree, recorded in `.tau/state.json`, until `/tdd on`. Both cases print a notice in
`run_tests` summaries, but only the explicit switch appears in commit results. Protected paths stay
blocked either way. Ask the user before turning the gate off.

## See also

- [Phase storage and transitions](../../src/extensions/tdd/state.ts)
- [Production globs and protected paths](../../src/extensions/tdd/config.ts)
- [Skill authoring style](../../docs/adr/0004-skill-authoring-style.md)
