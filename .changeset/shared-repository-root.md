---
'tau': patch
---

The `improvement` tool resolves a task's project root with `findSharedRepositoryRoot`, so every
worktree shares one repository root. A conventional bare repository now resolves to itself, not its
parent directory.
