---
'tau': minor
---

Replace the subagent status lifecycle flags with one derived `state`. `subagent_status` now reports
`starting`, `running`, `awaitingReply`, `reported`, `stopping`, `stopped`, `cleanupUnconfirmed`, or
`notOwned`, plus `recovery` for `cleanupUnconfirmed` and `notOwned`. `outcome` is omitted until a
report, terminal event, settled record, or cleanup exists. Generic workers report `nativeState` only
for an owned live handle.

Replies now return a `delivery` value: `sent`, `uncertain`, `notResent`, or `notDelivered`. Pi
replies never throw after the reply is saved.

`subagent_history` drops `sourceFile`, `rootSessionId`, `rootSessionFile`, and the paging and
retrieval metadata. Candidates carry `state`, exclude the current session and its ancestors, and
include `reportFile` only when report fields are truncated. `nativeSessionFile` appears only for
native-only sessions or unavailable native evidence.
