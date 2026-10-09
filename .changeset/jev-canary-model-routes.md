---
'tau': minor
---

A route in `tau.json` can set `canary`, a share from 0 to 1. When Jev picks a model that differs
from the profile model with enough confidence, the worker runs on the picked model with that
probability. Without `canary`, workers still run on the profile model. A launch that names a
`model`, or a fallback pick, never runs as a canary. The picked model must pass `allowedModels` and
exist in the registry, or the launch fails. Task records move to version 9 and save whether the
launch ran as a canary. Version 8 and 7 records stay readable.

```json
"scout": {
  "model": "claude-bridge/claude-opus-5-5",
  "routes": {
    "canary": 0.1,
    "question": "How wide is this scout brief?",
    "labels": {
      "narrow": { "criterion": "A lookup about known code.", "model": "claude-bridge/claude-haiku-5-5" },
      "wide": { "criterion": "An investigation across many files.", "model": "claude-bridge/claude-opus-5-5" }
    }
  }
}
```
