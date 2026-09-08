---
'tau': minor
---

Enforce TDD with test evidence: `run_tests` records red, green, and verified per behavior; file-tool
writes to files matching the production globs are blocked until a focused test has failed through
tau's runner; skipped or deleted tests never count; evidence persists to `.tau/state.json` per
worktree. The gate turns off with a notice when no test runner resolves from the worktree, and
`/tdd on|off|status` switches it per worktree with the opt-out recorded in the evidence file.
