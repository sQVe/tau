---
'tau': minor
---

Compact manager sessions at Pi turn boundaries. Once the context passes 200,000 tokens, Tau writes a
summary between turns and the run continues without an abort. Set the threshold with
`compaction.thresholdTokens` in `tau.json`. The summary starts with a worker ledger that Tau builds
from saved worker records: task IDs, profiles, states, pending question IDs, successors, and report
evidence. A model summary follows and keeps scope, user authorization, worktrees, identifiers, and
check evidence. Workers keep Pi's own compaction, and Pi's settings stay unchanged. A failed or
aborted summary leaves the full context in place.
