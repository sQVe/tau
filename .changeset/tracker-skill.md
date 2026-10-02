---
'tau': minor
---

The `tracker` skill writes Linear tickets by one set of rules. It has a template for each ticket
type, routes each ticket to its team and project, and searches for an open duplicate before it
creates one. Starting a slice moves it to In Progress; no skill makes any other status change. The
`slice`, `start-slice`, `pr`, and `pr-feedback` skills follow it when they write to Linear.

`slice.agentTeam` is now `tracker.agentTeam` in `~/.pi/agent/tau.json`, and a config that still sets
`slice` is an error. Each repository also needs a `tracker.repositories` entry keyed by its `origin`
remote's `owner/name`, with its team and an optional project:

```json
{
  "tracker": {
    "agentTeam": "AI",
    "repositories": { "sQVe/tau": { "team": "ME", "project": "Tau" } }
  }
}
```
