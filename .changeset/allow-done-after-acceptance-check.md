---
'tau': patch
---

The tracker skill allows a merged PR's ticket to move to Done only after an affirmative read that
the PR is merged, no open acceptance item and no deferred check, saved evidence that records the
merged revision, and a ticket that is still open. It reports an unverified result when the read-back
of the new state fails. The pr skill points at that rule.
