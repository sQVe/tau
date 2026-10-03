---
'tau': patch
---

Make the pr-feedback, update-branch, and stack skills clearer and shorter. pr-feedback now skips the
rebase only when `mergeable` stays `UNKNOWN`, and reports a failing check's cause only when known.
update-branch asks for an unclear target and notes the remote tip when it resumes a rebase, so the
push has a lease. stack fetches before the remote-history check that runs before sync. That check
now compares against the tip from before the first rebase since the branch's last push, and lets a
branch that is only behind its remote fast-forward instead of stopping.
