---
'tau': minor
---

Bundled subagent profiles default to `claude-bridge/claude-opus-5-5`, and `TAU_SUBAGENT_MODEL`
replaces that default. `timeoutSeconds` is optional: investigation profiles get 30 minutes and
editing profiles 60. A launch at the worker cap now lists the live workers with their deadlines and
says to retry after a stop notice.
