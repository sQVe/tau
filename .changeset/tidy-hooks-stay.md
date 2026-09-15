---
'tau': patch
---

Keep successful Git hook content and message rewrites and added paths committed. Report the stored
message, committed files, and changes from the reviewed tree. Preserve raw hook failures and commit
success information when cleanup or reporting fails.

Limit automatic comment-review returns to two per group. Remaining findings cause a refusal. New
dispute evidence cannot reopen a refused tree; corrected trees remain reviewable. Stop remaining
groups when an earlier hook committed their requested changes and no new staged changes remain.
