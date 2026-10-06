# ADR 0047: Default bundled worker profiles to Opus 5.5

**Date**: 2026-09-25\
**Status**: Superseded\
**Superseded by**:
[ADR 0071 (Set worker models in the user config)](./0071-set-worker-models-in-the-user-config.md)\
**Related**: [ADR 0043 (Own only the worker guarantees herdr lacks)](./0043-own-only-the-worker-guarantees-herdr-lacks.md),
[Development](../development.md), [ME-427](https://linear.app/sqve/issue/ME-427), the audit of
refused worker launches

## Context

The bundled `scout`, `worker`, and `reviewer` profiles named no model, and `TAU_SUBAGENT_MODEL` is
usually unset. Pi worker launch then refused. A session audit found 86 such refusals, and at least
16 were retried at once with a model.
[ADR 0043](./0043-own-only-the-worker-guarantees-herdr-lacks.md) still forbids falling back to the
parent's model, because the parent's runtime settings are not reproducible in a worker.

Past worker records mostly used `claude-bridge/claude-opus-5-5` for editing work, with a mix of
models for investigation. The owner chose Opus 5.5 for all three profiles.

## Decision

The bundled profiles name `claude-bridge/claude-opus-5-5`. Naming a model in each bundled profile
keeps an exact, visible model and needs no new setting. For a bundled profile, select the launch
`model`, then `TAU_SUBAGENT_MODEL`, then the profile's model. For a user or project profile, select
the launch `model`, then the profile's model, then `TAU_SUBAGENT_MODEL`. The environment overrides
bundled defaults but never a model the user wrote into a profile. A user can also shadow a bundled
profile with a file of the same name in `~/.pi/agent/agents/` or `.pi/agents/`.

Native harnesses ignore the bundled model, because it names a Pi provider. They still select models
through native arguments.

## Consequences

### Positive

- Bundled profiles launch without a model argument.
- The model stays exact and never follows the parent.

### Negative

- A user without `claude-bridge` credentials gets a refusal until they set `TAU_SUBAGENT_MODEL` or
  pass `model`.
- The default reflects the owner's choice and past use, not a recorded comparison.

## Alternatives considered

### Keep refusing without a model

Keep refusing a launch without a model. Rejected because every launch then repeats a model argument.

### Fall back to the parent's model

Fall back to the parent's model. Rejected because ADR 0043 forbids this.
