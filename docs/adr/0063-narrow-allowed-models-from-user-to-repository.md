# ADR 0063: Narrow allowed models from the user file to the repository file

- Status: Accepted
- Date: 2026-09-28

## Context

- Tau selects models in subagent profiles, the `subagent` tool's `model` parameter, the
  `TAU_SUBAGENT_MODEL` environment variable, the delegate for `bulk_read` and web answers, and saved
  worker replays. Nothing stopped any of them from using a model the user does not want to pay for
  or trust.
- Every selection passes through `resolveDelegate` or the subagent loadout's `findModel`.
- ADR 0061 layers Tau config from `<agentDir>/tau.json` and a trusted repository's `.pi/tau.json`,
  where the repository file overrides the user file per field. A repository is trusted to run code,
  but its checked-in config is written by other people for every user of the repository.
- Pi's `enabledModels` setting lists the models Pi cycles through. It is not a limit, and Tau leaves
  it alone.

## Options considered

- Reuse ADR 0061's per-field override. Rejected: a repository could then replace the user's list
  with models the user never allowed, which defeats the reason for the list.
- Ignore `allowedModels` in the repository file. Rejected: a repository could not keep its own work
  to a smaller set, such as models approved for a client's code.
- Silently drop repository entries the user did not allow. Rejected: the effective list would be
  right, but a repository author would never learn that their list does not apply.
- Intersect the lists and refuse a repository list that names a model the user did not allow.
  Chosen: the user's list holds, and a repository can still narrow it.

## Decision

A top-level `allowedModels` array of `provider/model-id` references limits every model Tau selects.
The repository list can only narrow the user list.

- Without `allowedModels` in either file, every model is allowed.
- Each layer that sets the list must be a subset of the list before it, so the effective list is the
  last one set. A repository list that names a model the user file does not allow is an error that
  names the repository file, the added models, and the user list.
- A model outside the effective list is refused with an error that names the model, the list, and
  the files it came from. Tau never falls back to another model or provider.
- The check runs once in `resolveDelegate` and once in `findModel`, not in their callers. A worker
  launch, an environment or profile model, and a saved worker replay all pass through `findModel`.
- Entries use the same parser as other model references. An invalid entry or a non-array value is an
  error that names the file, like the rest of Tau config.
- The shared file reading from ADR 0061 moves to `src/tauConfig.ts`. Each consumer validates its own
  top-level key, so a broken `tdd` block never blocks model selection and a broken `allowedModels`
  never pauses TDD hints.

## Tradeoffs

- A user's list holds in every repository, whatever the repository checks in.
- A repository can still keep its work to fewer models.
- The refusal names the file to edit, so a user can see why a model was refused.
- Cost: a repository list that names a model the user did not allow blocks every model selection in
  that repository until the user allows the model or the repository removes it.
- Cost: Tau reads both config files on each selection, including the delegate lookup before each
  clamped `read`.
- Cost: two lists limit models in Pi, `enabledModels` and `allowedModels`, and they can disagree.

## See also

- [ADR 0027: Share one delegate model across bounded tool tasks](./0027-share-one-delegate-model.md)
- [ADR 0055: Record Tau coding conventions in `AGENTS.md`](./0055-record-tau-coding-conventions-in-agents-md.md)
- [ADR 0061: Layer Tau config from user and repository files](./0061-layer-tau-config-from-user-and-repository-files.md)
