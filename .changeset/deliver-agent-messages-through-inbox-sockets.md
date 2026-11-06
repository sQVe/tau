---
'tau': patch
---

Handovers and worker answers now go through each session's inbox socket, and nothing types into
another agent's terminal. `handover` `send` returns `queued` only after the receiving session has
saved the message, and the manager answers a worker question with `subagent_answer`. A bash
`hc send` or `hc keys` in a Tau session is refused. Running managers and workers must `/reload` or
restart to get the new inbox and `subagent_answer`.
