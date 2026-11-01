---
'tau': patch
---

Merge watch reads `gh pr merge --auto` with the shared shell parser. It now finds merges in
`$(...)`, backticks, subshells, and expanding heredoc bodies, and reads the right pull request
across line continuations and comments. A command the parser rejects starts no watch.

The shared shell parser no longer lists commands from a heredoc delimiter word, which the shell does
not run. The commit guard and the wait guard use the same parser, so they also stop reading those
commands.
