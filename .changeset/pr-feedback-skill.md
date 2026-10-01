---
'tau': minor
---

The `pr-feedback` skill runs one feedback round on a GitHub pull request. On the user's own PR it
rebases onto the base when the PR conflicts, then verifies unresolved review comments and failing CI
checks. It fixes the valid ones, pushes once, replies, and resolves the threads. It reports CI
failures that also fail on the base or come from outside the PR's changes instead of fixing them. On
someone else's PR it checks whether the author fixed the user's comments and reports failing checks
and conflicts. Drafts to people are shown before posting.

The pr skill writes commit SHAs in PR bodies the same way, so they link.
