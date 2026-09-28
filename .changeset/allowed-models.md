---
'tau': minor
---

Refuse any model outside an `allowedModels` list in `~/.pi/agent/tau.json`. A trusted repository's
`.pi/tau.json` can only remove models from that list, and a repository list that adds one is an
error. The list covers subagent launches, profile and environment models, saved worker replays, and
the delegate for `bulk_read` and web answers. A refusal names the model, the effective list, and the
files it came from, and Tau never falls back to another model. Without the list, nothing changes.
