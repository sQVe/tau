---
'tau': patch
---

Make the pr-feedback, update-branch, and stack skills clearer and shorter. pr-feedback now skips the
rebase only when `mergeable` stays `UNKNOWN`, and reports a failing check's cause only when known.
update-branch notes the remote tip when it resumes a rebase, so the push has a lease. stack fetches
before the remote-history check that runs before sync.
