---
'tau': minor
---

Suggest `/compact` once a manager session's context passes 200,000 tokens. Tau shows the notice once
per crossing and never compacts by itself.

After a compaction, the manager gets a list of its workers that have not stopped and their pending
question IDs with the next prompt. Tau sends nothing when every worker has stopped with no pending
question.

A worker notice that arrives during `/compact` now joins the next prompt instead of starting a turn
beside the summary.
