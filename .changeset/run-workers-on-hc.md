---
'tau': minor
---

Subagent workers now run as `hc` child terminals, so Tau needs `hc`. Start Tau inside an `hc`
terminal. `subagent` refuses a launch outside one.

Tau removed these tools: `subagent_status`, `subagent_cancel`, `subagent_reply`,
`subagent_follow_up`, `subagent_question`, and `subagent_progress`. Remove calls to them from your
prompts and skills. Until later changes add them back on `hc`, a manager cannot follow up, reply to,
or cancel a worker, and a worker cannot ask a question.

A worker's report reaches its manager as a short `hc` note with the path of its assignment file. The
manager shows each report once. Earlier task records are not read.
