---
'tau': minor
---

Enforce TDD with test evidence: `run_tests` records red, green, and verified per behavior; file-tool
writes to production paths are blocked until a focused test has failed through tau's runner; skipped
or deleted tests never count; evidence persists to `.tau/state.json` per worktree.
