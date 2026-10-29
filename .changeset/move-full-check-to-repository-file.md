---
'tau': minor
---

The full check command moves to the repository file. Set `fullCheck.argv` in `.pi/tau.json`, for
example `{ "fullCheck": { "argv": ["pnpm", "check"] } }`. Tau reads it only in a trusted project.
Remove the `fullCheck.repositories` entry from `~/.pi/agent/tau.json`: a `fullCheck` key in the user
file now fails the `full_check` tool and names `.pi/tau.json`.
