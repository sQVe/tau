---
'tau': minor
---

`draft_review` has an `open` action. It starts tuicr beside the agent in a right split or a new tab
without moving focus, and returns at once. A later `collect` closes that tuicr, waits for it to
exit, and then reads the comments and edits. When the user was in the tuicr tab, focus returns to
the agent's tab. Outside herdr, `open` returns the command to run, as `review` does. Review records
move to format version 2.
