---
'tau': minor
---

Enforce TDD with test evidence. `run_tests` records red, green, and verified per behavior. Block
file-tool writes to files matching the production globs until a focused test fails through Tau's
runner. Skipped or deleted tests never count. Save evidence to `.tau/state.json` per worktree.

Turn the gate off with a notice when no test runner resolves from the worktree. Use
`/tdd on|off|status` to control the gate per worktree. Record the opt-out in the evidence file.
