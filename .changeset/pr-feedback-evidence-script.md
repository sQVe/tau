---
'tau': patch
---

`pr-feedback` gathers each round's threads, comments, viewer, author, head, checks, and failed-log
excerpts with one read-only `codemode` script that calls the `pr_feedback` tool's `read` and
`checks`. A read that fails or comes back incomplete is reported as a gap, never as "no comments" or
as a passing check. The skill no longer reads the viewer, the checks, or check logs with separate
`gh` commands.
