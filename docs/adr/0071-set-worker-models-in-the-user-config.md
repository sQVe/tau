# ADR 0071: Set worker models in the user config

**Date**: 2026-09-30\
**Status**: Accepted; built-in worker model superseded by
[ADR 0072 (Keep model defaults out of code)](./0072-keep-model-defaults-out-of-code.md); the rule
that Tau never routes superseded by
[ADR 0099 (Warn on unknown config keys and fail only the entry in use)](./0099-warn-on-unknown-config-keys-and-fail-only-the-entry-in-use.md)\
**Supersedes**:
[ADR 0047 (Default bundled worker profiles to Opus 5.5)](./0047-default-bundled-worker-profiles-to-opus-5-5.md)\
**Related**:
[ADR 0043 (Own only the worker guarantees herdr lacks)](./0043-own-only-the-worker-guarantees-herdr-lacks.md),
[ADR 0061 (Layer Tau config from user and repository files)](./0061-layer-tau-config-from-user-and-repository-files.md),
[ADR 0063 (Narrow allowed models from the user file to the repository file)](./0063-narrow-allowed-models-from-user-to-repository.md)

## Context

Every bundled worker profile names `claude-bridge/claude-opus-5-5`, so quick lookups and short QA
runs spend frontier quota. The user wants cheaper models for some profiles and wants Tau token-lean.

A worker's model could come from four places: the launch `model`, `TAU_SUBAGENT_MODEL`, and the
`model:` key in a bundled, user, or repository profile file. A repository profile in `.pi/agents/`
could pick a model the user never chose.

The manager can pass `model` on a launch, but it never sees which models it may use. For a
multi-model discussion it has to guess names or read Pi's settings.

[ADR 0043](./0043-own-only-the-worker-guarantees-herdr-lacks.md) keeps model choice with the manager
or with config decided once at launch. Tau never routes or falls back.

## Decision

Worker models come only from the launch `model` and the user file `<agentDir>/tau.json`. Profile
files no longer name a model. With one model map in the user config, the user sets every worker
model in one file, and profiles describe only the job.

### Config

- `profiles.<name>.model` sets the model for one profile. `profiles.default.model` sets it for every
  profile without its own entry. `default` is a reserved profile name.
- Only the user file may set `profiles`. A repository `.pi/tau.json` that sets it is an error that
  names the file, for the reason [ADR 0063](./0063-narrow-allowed-models-from-user-to-repository.md)
  gives: the user owns which models they pay for and trust.
- Tau validates the shape when it reads the file. It checks a profile name only at launch, because a
  profile may exist only in one trusted repository.

### Selection

At launch, Tau selects the first of:

1. The manager's `model`.
2. `profiles.<name>.model`.
3. `profiles.default.model`.
4. The built-in `claude-bridge/claude-opus-5-5`.

The selected model must pass `allowedModels`. Only the selected model is checked, so a repository
that disallows one default still accepts an explicit allowed model. `TAU_SUBAGENT_MODEL` is removed.

### Profile files

A profile file with a `model:` key is an error that names the file and says to move the model into
`tau.json`. `thinking:` stays in profile files.

### Manager guidance

The `subagent` tool description lists the models the manager may pass and each profile's default. It
is built on `session_start` from Pi's scoped models, filtered by `allowedModels`, plus every profile
default. It stays fixed for the session, so the prompt cache holds. The guidance says to use the
profile default unless the user asks for another model or a multi-model discussion.

## Consequences

### Positive

- A user sets every worker model in one file and keeps the bundled profiles.
- A repository cannot choose a model for the user.
- The manager can name real models when the user asks for several.
- Without `profiles`, workers run on Opus 5.5 as before.

### Negative

- A user or repository profile file with `model:` stops loading until the key moves into `tau.json`.
- A repository cannot set a model for its own profiles.
- The model line adds tokens to every turn in a herdr session. With six scoped models it is 269
  characters, about 70 tokens by a four-characters-per-token estimate.
- Difficulty stays with the manager. An easy task on `worker` runs on the `worker` default unless
  the manager passes `model`.

## Alternatives considered

### Models in profile files

Keep models in profile files and change the bundled defaults. Rejected because the bundled choice
would suit only one user, and changing a default would mean copying a whole profile.

### Model tiers

Use tiers such as `cheap`, `mid`, and `frontier`, with a per-model catalog, quota headroom from
`ai-usagebar`, and a saved reason for each pick. Rejected because there is no observed need beyond
per-profile defaults, and it adds config, a tool, and a task record format change. Deferred until
task records show frontier workers on trivial tasks.

### Profile file model wins over config

Let a model written in a user or repository profile file win over config. Rejected because it keeps
two places to set a model, and a repository could still choose one for the user.
