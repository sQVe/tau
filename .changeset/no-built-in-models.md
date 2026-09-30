---
'tau': minor
---

Tau no longer names a model of its own. Set every model it uses in `~/.pi/agent/tau.json`:

- Workers need a launch `model`, `profiles.<name>.model`, or `profiles.default.model`. Without one,
  the launch fails and names `profiles.default.model`. Workers no longer default to
  `claude-bridge/claude-opus-5-5`.
- `bulk_read` needs `bulkRead.model`, such as
  `{"bulkRead": {"model": "openai-codex/gpt-5.6-luna"}}`. Only the user file may set it. Without a
  usable one, the session starts with `bulk_read` and its guidelines hidden, and reads are not
  clamped. `profiles.default` does not apply.
- `TAU_DELEGATE_MODEL` is removed.

Tau no longer sets the web answer model. Set it with `fetch.answerProvider` and `fetch.answerModel`
in pi-web-access's `web-search.json`; without them, web answers use the session model. Tau still
refuses an `answerModel` passed on a call when it is outside `allowedModels`.
