---
'tau': patch
---

The commit guard now decodes `$'...'` text as Bash does, so it blocks `git commit` spelled with
escapes, such as `git $'com\x6dit'` or `$'g\x69t' commit`. Text such as `echo $'a\tb'` is still
allowed.
