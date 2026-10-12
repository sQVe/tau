---
'tau': minor
---

`profiles.<name>.routes` in `tau.json` is now `route`, and it names its own classifier in
`route.classifier` as a `provider/model-id`. Tau no longer picks a classifier model. The classifier
must pass `allowedModels`, or classification is skipped and the worker runs on the profile model.

To edit an existing profile, rename `routes` to `route` and add `classifier`. A profile that still
sets `routes`, or a `route` without `classifier`, turns routing off with an error that names the
field. The worker still launches on its `model`.

```json
"scout": {
  "model": "claude-bridge/claude-opus-5-5",
  "route": {
    "classifier": "my-provider/my-classifier",
    "question": "How wide is this scout brief?",
    "labels": {
      "narrow": { "criterion": "A lookup about known code.", "model": "claude-bridge/claude-haiku-5-5" },
      "wide": { "criterion": "An investigation across many files.", "model": "claude-bridge/claude-opus-5-5" }
    }
  }
}
```
