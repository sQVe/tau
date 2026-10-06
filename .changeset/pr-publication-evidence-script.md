---
'tau': minor
---

The `pr` skill gathers publication evidence and linked ticket intent in one bounded, read-only
`codemode` script. It uses the returned review reuse status and matches saved check logs against
HEAD, worktree status, and the branch diff before reading their results. Target questions, reviews,
rebases, and publication approval stay outside the script.
