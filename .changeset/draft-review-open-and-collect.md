---
'tau': minor
---

`draft_review` has an `open` action. It starts tuicr in a new tab of the manager's space without
moving focus, and returns at once. A later `collect` closes that tuicr, waits for it to exit, and
then reads the comments and edits. Without a manager terminal, `open` returns the command to run, as
`review` does. Review records move to format version 2.
