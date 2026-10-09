---
'tau': minor
---

Main sessions now refuse passive wait commands even when no worker is active. The refused commands
are `while` or `until` loops that run `sleep`, `gh run watch`, `gh pr checks` with `--watch`,
`aws logs tail` with `--follow` or `-f`, and `watch`. A `while` loop that reads input is allowed.
The refusal tells the manager to check the state once, report it and what it waits for, and end its
turn. Worker sessions are unchanged.
