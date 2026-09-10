---
'tau': patch
---

Read shared TDD gate state from disk for every permission decision. Serialize state updates across
Pi processes so test runs and gate switches preserve each other's evidence. Report the same
effective gate state in permissions, tool results, and the footer, including when no test runner is
available. Stop showing the gate-off marker when evidence cannot be read, since the guard blocks
every write in that state. Keep test paths and RED coverage warnings correct when a session uses a
symlinked worktree path.
