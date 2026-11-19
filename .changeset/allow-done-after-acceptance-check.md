---
'tau': patch
---

The tracker skill allows a merged PR's ticket to move to Done only after an affirmative read that
the PR is merged, no deferred check, saved evidence that records the merged revision and shows each
acceptance item met, and a ticket that is still open. The evidence is the newest `full_check` record
for the revision's tree with `passed` true, a completed review report with no open finding, or a
slice audit with a `met` verdict, and only the source an acceptance item needs is required. Ticket
checkboxes are not evidence. It reports an unverified result when the read-back of the new state
fails. The pr skill points at that rule.
