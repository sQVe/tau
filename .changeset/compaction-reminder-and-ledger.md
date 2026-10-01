---
'tau': minor
---

Suggest `/compact` once a manager session's context passes 200,000 tokens. Tau shows the notice once
per crossing and never compacts by itself.

After a compaction, the manager gets a list of its active workers and pending question IDs with the
next prompt. Tau sends nothing when no worker is active or has a pending question.

A worker notice that arrives during `/compact` now joins the next prompt instead of starting a turn
beside the summary.
