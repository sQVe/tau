# ADR 0071: Keep model defaults out of code

- Status: Accepted
- Date: 2026-09-30
- Supersedes: [ADR 0027](./0027-share-one-delegate-model.md),
  [ADR 0044](./0044-restore-gpt-5-6-luna-as-the-delegate-default.md), and the built-in worker model
  in [ADR 0070](./0070-set-worker-models-in-the-user-config.md)

## Context

- Tau named two models in code: `claude-bridge/claude-opus-5-5` for workers without a configured
  model, and `openai-codex/gpt-5.6-luna` for `bulk_read` and web answers. Each assumes one user's
  providers and subscriptions, so another user gets refusals or spends quota they did not choose.
- The model for `bulk_read` and web answers was set with `TAU_DELEGATE_MODEL`, apart from the other
  model settings in `tau.json`. "Delegate" was an internal word that did not say what it controlled.
- `pi-web-access` already reads its own default answer model from `fetch.answerProvider` and
  `fetch.answerModel` in `web-search.json`. Tau set `answerModel` on every call only to apply its
  own default.

## Options considered

- Keep the defaults and let config override them. Rejected: Tau would still work out of the box only
  for users with the same providers.
- Fall back to the parent session's model. Rejected:
  [ADR 0043](./0043-own-only-the-worker-guarantees-herdr-lacks.md) keeps workers off the parent's
  runtime settings.
- One shared key for helper tasks, such as `smallModel`. Rejected: it names a model size, not a job,
  and Tau would keep choosing web answer models for another package.
- One `models` block for every model setting, or user-named aliases. Rejected: both move settings
  away from the consumer that owns them, and aliases add a lookup close to the tiers ADR 0070
  deferred.
- A key per tool, owned by that tool, and web answers left to `pi-web-access`. Chosen: each name
  says what it controls, and it follows the per-consumer keys in
  [ADR 0061](./0061-layer-tau-config-from-user-and-repository-files.md).

## Decision

Tau's code names no model. Every model Tau uses comes from a launch or call argument, or from the
user's `<agentDir>/tau.json`.

### Workers

A launch uses the manager's `model`, then `profiles.<name>.model`, then `profiles.default.model`.
Without any of them, the launch fails with an error that names `profiles.default.model` in the user
file and lists the models Pi has scoped.

### `bulk_read`

`bulkRead.model` in the user file sets the model. Only the user file may set `bulkRead`; a
repository `.pi/tau.json` that sets it is an error that names the file. Without it, `bulk_read`
fails with an error that names the key. `profiles.default` does not apply. `TAU_DELEGATE_MODEL` is
removed.

### Web answers

Tau no longer sets `answerModel`. `pi-web-access` uses its own `fetch.answerModel` setting, or an
`answerModel` the caller passes. Tau still refuses a passed `answerModel` outside `allowedModels`.

## Tradeoffs

- Tau makes no provider assumption, so another user configures only the models they have.
- Each setting's name says what it controls, and each tool can add settings under its own key.
- Cost: a new user must write `tau.json` before workers or `bulk_read` run. The errors name the key
  to set.
- Cost: web answer models are set in `pi-web-access`'s own file. Without that setting,
  `pi-web-access` answers with the session model.
- Cost: `allowedModels` no longer covers `pi-web-access`'s configured answer model, only one passed
  per call.
- Cost: `bulk_read` and web answers no longer share one setting, so switching both means editing two
  files.

## See also

- [ADR 0063: Narrow allowed models from the user file to the repository file](./0063-narrow-allowed-models-from-user-to-repository.md)
