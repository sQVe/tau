---
'tau': patch
---

Give each worker a short scratch `TMPDIR` at
`<agentDirectory>/tmp/ws/<first 8 hex of the assignment ID>`, so `browser` and `qa` workers can
start Chrome without a `Socket path too long` error. You may delete the old
`<agentDirectory>/tmp/tau-worker-scratch` folders.
