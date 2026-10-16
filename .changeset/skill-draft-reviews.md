---
'tau': minor
---

The tracker, slice, brainstorm, and pr skills now offer "Review in tuicr" as the recommended choice
before they write a ticket, apply a slice plan, stop in a brainstorm round, or publish a PR. Picking
it opens the draft with the `draft_review` tool, applies your comments and edits, and asks again. A
review never counts as approval. The slice skill saves a readable `plan.md` next to `plan.json`, and
the pr skill saves the PR title and release notes next to `body.md` so they can be reviewed too.
