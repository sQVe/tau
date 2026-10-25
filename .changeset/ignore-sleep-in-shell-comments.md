---
'tau': patch
---

The wait guard no longer refuses a Bash command whose shell comment mentions a long `sleep`, a loop,
or a watcher, such as `printf ok # sleep 600`. A `#` starts a comment only at the start of a word
and outside quotes, so `echo a#b; sleep 600` is still refused. A command with a command substitution
keeps its comments, because the guard cannot follow quotes nested inside it.
