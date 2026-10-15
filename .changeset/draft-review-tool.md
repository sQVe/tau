---
'tau': minor
---

The new `draft_review` tool shows drafts under `.tau/` to the user in tuicr, in a herdr pane beside
the agent, and waits until tuicr exits. It returns the user's line comments on those drafts and a
diff of each draft the user edited. It writes the edits back unless the agent changed the file
during the review, and deletes only the comments it returned. Outside herdr it returns the tuicr
command, and a `collect` call finishes the review. Skills do not call it yet.
