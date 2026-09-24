---
'tau': patch
---

Explain cross-worktree refusals. Subagent launches outside the session cwd point to the agent
already running there. Commit paths outside the session cwd, and commits from a folder that is not a
Git work tree, say to commit from a session in the owning worktree. When Vitest lookup fails,
`run_tests` says tests run from the session cwd and names the package root of requested files that
lie outside it.
