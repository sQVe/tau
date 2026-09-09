---
'tau': minor
---

Allow one TDD behavior to name several tests. Each named test must fail in RED and pass in GREEN.
Focused passes accept test edits and report them during full verification. GREEN permits cleanup;
changed inputs invalidate passing results. Full runs name stale inputs and explain how to renew
them. Returning to an earlier behavior keeps its RED, including after verification. The `behavior`
label no longer forms part of the behavior's identity.

Allow new, empty production files before RED so tests can import missing modules. Existing files
remain guarded. Paths outside the worktree stay ungated, but symlink aliases cannot bypass protected
paths or production globs. Reject dangling symlinks and malformed stored evidence before they can
authorize writes. Run Vitest with Node when Pi is a compiled executable.

Label committed-title coverage as an estimate, and keep the TDD skill focused on the test cycle and
recovery steps.

Run the root `package.json` check script on each staged candidate before commit approval. Failed
checks and check-time changes to tracked files block the commit. Use installed root dependencies; do
not install packages. Report missing check scripts as unavailable instead of treating them as a
passing check.
