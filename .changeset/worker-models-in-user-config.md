---
'tau': minor
---

Set worker models in `~/.pi/agent/tau.json` with `profiles`, such as
`{"profiles": {"scout": {"model": "openai-codex/gpt-6.1-sol"}}}`. `profiles.default` applies to
every profile without its own entry, and workers otherwise run on `claude-bridge/claude-opus-5-5`. A
launch `model` still overrides both. A repository `.pi/tau.json` that sets `profiles` is an error.

Profile files no longer accept `model:`. A profile file that sets it stops loading until you move
the model into `tau.json`. `TAU_SUBAGENT_MODEL` is removed.

The `subagent` tool description now lists the models the manager may pass and each profile's
default.
