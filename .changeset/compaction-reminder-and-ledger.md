---
'tau': minor
---

Suggest `/compact` once a manager session's context passes 200,000 tokens. Tau shows the notice once
per crossing and never compacts by itself. Set `{"compaction": {"reminderTokens": 150000}}` in
`~/.pi/agent/tau.json` or `.pi/tau.json` to change the threshold.

After every compaction, the manager gets its worker ledger with the next prompt: task IDs, states,
pending question IDs, and report evidence from the saved worker records.

A worker notice that arrives during `/compact` now joins the next prompt instead of starting a turn
beside the summary.
