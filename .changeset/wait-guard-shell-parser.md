---
'tau': patch
---

The wait guard reads bash commands with the same shell parser as the commit guard. It ignores
`sleep` in comments and quoted text, and still counts it in command substitutions and in scripts
that a shell runs.
