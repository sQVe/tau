---
'tau': minor
---

Worker profiles in `tau.json` can set `routes`: a question and two labels, each with a criterion and
a model. When a launch names no `model`, Tau asks the Jev classifier which label fits the brief,
with a 5-second limit, and saves the model it would pick in the task record. The worker still runs
on the profile model. A pick needs a confidence of 0.7; a low confidence, an error, a timeout, or a
Jev model outside `allowedModels` records the profile model and the reason. Task records move to
version 8; version 7 records stay readable.

```json
"scout": {
  "model": "claude-bridge/claude-opus-5-5",
  "routes": {
    "question": "How wide is this scout brief?",
    "labels": {
      "narrow": { "criterion": "A lookup about known code.", "model": "claude-bridge/claude-haiku-5-5" },
      "wide": { "criterion": "An investigation across many files.", "model": "claude-bridge/claude-opus-5-5" }
    }
  }
}
```
