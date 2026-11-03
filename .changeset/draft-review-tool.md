---
'tau': minor
---

The new `draft_review` tool shows drafts under `.tau/` to the user in tuicr. Its `open` action
starts tuicr in a new tab of the manager's space without moving focus and returns at once. Its
`collect` action waits until tuicr exits, then returns the user's line comments on those drafts and
a diff of each draft the user edited. It writes the edits back unless the agent changed the file
during the review, and deletes only the comments it returned. Without a manager terminal, `open`
returns the tuicr command to run, and `collect` finishes the review.
