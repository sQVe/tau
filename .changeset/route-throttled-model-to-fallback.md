---
'tau': minor
---

Add the user-file `fallbackModels` config, which registers each entry as the virtual model
`tau/<name>` and routes to its fallback model from the configured consecutive retry until the next
user message. An entry that names another `tau/<name>` as its primary or fallback is refused.
