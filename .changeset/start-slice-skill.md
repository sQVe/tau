---
'tau': minor
---

The `start-slice` skill starts one slice of a planned design. It picks the next slice from order,
dependencies, and merge state, then previews the branch, its base, and the agent tickets for one
approval. After approval it creates the branch and the agent tickets, and hands the work to workers.
Set the Linear team for agent tickets with `slice.agentTeam` in `~/.pi/agent/tau.json`; the manager
prompt names it.
