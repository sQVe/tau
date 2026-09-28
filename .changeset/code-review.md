---
'tau': minor
---

Add the `/code-review` command and skill. It reviews a branch, uncommitted work, a commit or range,
or named files. A fast review, the default, uses one fresh reviewer that checks its own findings.
`/code-review deep` adds a fresh checker that tests each finding and looks for omissions. Each
finding states whether it was checked independently.
