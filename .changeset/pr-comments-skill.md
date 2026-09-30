---
'tau': minor
---

The `pr-comments` skill runs one review round on a GitHub pull request. On the user's own PR it
verifies unresolved review comments, fixes the valid ones, pushes, replies, and resolves the
threads. On someone else's PR it checks whether the author fixed the user's comments. Drafts to
people are shown before posting.

The pr skill writes commit SHAs in PR bodies the same way, so they link.
