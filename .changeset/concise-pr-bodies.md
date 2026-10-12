---
'tau': patch
---

The `pr` skill now writes pull request bodies of about 100 to 150 words. Verification lists only
outcomes and gaps, and review history, commit SHAs, and test counts move to the session report.
After publishing, `pr` may post one self-review with inline comments for deliberate hunks that need
a reason. `pr_feedback` skips a review thread the viewer started while only the viewer has commented
in it, and lists it once anyone else replies.
