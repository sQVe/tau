---
'tau': patch
---

`slice` `apply` and `start_slice` `apply` share one partial-apply runner. A failed or aborted step
now returns an error tool result whose `details` hold `status`, `error`, `directory`, `applied`,
`notApplied`, and `created`, instead of only a thrown message.
