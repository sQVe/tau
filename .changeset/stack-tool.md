---
'tau': patch
---

The new read-only `stack` tool decides the stack check, the remote-history check before a push, and
the blocker-chain parent for `start-slice`. A failed or malformed read gives unknown or a stop,
never a guess. The `stack`, `start-slice`, `update-branch`, and `pr` skills call it instead of
reading `gh stack` exit codes, GitHub pull request lists, and `git cherry` output themselves.
