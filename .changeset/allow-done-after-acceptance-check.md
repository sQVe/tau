---
'tau': patch
---

The tracker skill allows a merged PR's ticket to move to Done only after an affirmative read that
the PR is merged, no open acceptance item and no deferred check, saved evidence that records the
merged revision and shows each needed outcome, and a ticket that is still open. The outcome is a
passed `full_check` record, a completed review report with no open finding, or a slice audit, and
only the source an acceptance item needs is required. It reports an unverified result when the
read-back of the new state fails. The pr skill points at that rule.
