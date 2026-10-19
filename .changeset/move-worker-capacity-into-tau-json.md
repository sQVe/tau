---
'tau': minor
---

The `TAU_SUBAGENT_CAP` environment variable is gone. Set `subagents.capacity` in
`~/.pi/agent/tau.json` to limit live workers, for example `{ "subagents": { "capacity": 12 } }`. It
takes an integer from 1 to 256, and only the user file may set it. The default is now 12 instead
of 4.
