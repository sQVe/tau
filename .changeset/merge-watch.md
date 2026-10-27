---
'tau': minor
---

After a bash call turns on auto-merge with `gh pr merge --auto`, Tau watches the pull request and
starts a new turn when it merges, a required check fails or is cancelled, it closes without merging,
or 2 hours pass without a merge.
