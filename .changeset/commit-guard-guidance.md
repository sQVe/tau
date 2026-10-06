---
'tau': patch
---

The commit guard no longer decodes escapes in `$'...'` strings. It still blocks plain `git commit`
commands in bash.
