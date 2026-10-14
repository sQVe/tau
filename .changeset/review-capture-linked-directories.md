---
'tau': patch
---

`code_review` `capture` no longer reads a file through a parent directory that links outside the
repository, and no longer fails on an untracked link to a directory. Both paths are reported as
`unreadable` gaps, and their contents never reach `input.md`.
