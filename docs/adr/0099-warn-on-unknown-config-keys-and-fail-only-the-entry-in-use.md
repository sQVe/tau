# ADR 0099: Warn on unknown config keys and fail only the entry in use

**Date**: 2026-10-09\
**Status**: Accepted\
**Supersedes**: the unknown key handling in
[ADR 0061 (Layer Tau config from user and repository files)](./0061-layer-tau-config-from-user-and-repository-files.md)
and
[ADR 0095 (Keep repository routing in tracker config)](./0095-keep-repository-routing-in-tracker-config.md)\
**Related**:
[ADR 0053 (Version each saved record format)](./0053-version-each-saved-record-format.md),
[ADR 0071 (Set worker models in the user config)](./0071-set-worker-models-in-the-user-config.md),
[ADR 0072 (Keep model defaults out of code)](./0072-keep-model-defaults-out-of-code.md)

## Context

Every Tau checkout reads the same user file, `<agentDir>/tau.json`, including older checkouts in
other worktrees. [ADR 0061](./0061-layer-tau-config-from-user-and-repository-files.md) ignores
unknown top-level keys for that reason, but each feature rejects unknown keys inside its own block.
When a newer Tau added `routes` under `profiles.<name>`, an older checkout refused the whole
`profiles` block.

Tau also parses every profile entry on each launch, so one bad entry blocks every profile. A
profile's model and its route sit in one entry, so a bad route also blocks the model.

The worker route sends the brief to a classifier model that Tau names in code. That breaks
[ADR 0072](./0072-keep-model-defaults-out-of-code.md), which says every model Tau uses comes from an
argument or the user's config. The route key is named `routes` but holds one route.

## Decision

Tau ignores an unknown key at any depth, in either file, with a warning, and a bad value fails only
the entry that reads it. A newer key then never breaks an older checkout, and one mistake never
blocks unrelated work.

### Unknown keys

- An unknown key at any depth in the user or repository file is ignored. Tau warns once per session
  with the file and the full key path.
- One shared helper finds unknown keys for every feature, so the rule cannot drift between features.
- A key Tau removed or renamed is not unknown. It fails the feature that owned it, with an error
  that names the replacement.

### Known keys

- A wrong type, a missing required field, or a user-only key in the repository file stays an error
  that names the file and the field. Tau never falls back to another value or model.
- The error fails only the entry being read. A bad `profiles.scout` blocks only `scout` launches. A
  bad `profiles.<name>.route` blocks only routing for that profile, never its `model`.
- Repository file rules stay as before: `tdd` overrides per field, `allowedModels` may only narrow,
  and every other key is user-only.

### No version field

The config has no version number. Changes add keys by default. Removing or renaming a key is allowed
and goes through the error above. A version does not help here, because an older checkout still
cannot read a newer file, and the user writes this file by hand, unlike the saved records in
[ADR 0053](./0053-version-each-saved-record-format.md).

### Model routes

- `profiles.<name>.route` holds one route: a `question`, exactly two `labels`, a `classifier` model,
  and an optional `canary` share. `routes` is a renamed key.
- The route names its own classifier, so Tau's code again names no model. Without `classifier`, the
  route is invalid and only routing for that profile stops. The classifier must pass
  `allowedModels`, because the brief leaves the machine.
- `profiles.<name>.model` stays required next to a route. It is the model when the classifier has no
  confident answer.

## Consequences

### Positive

- A newer Tau can add a key without breaking older checkouts.
- One bad entry or route no longer blocks every worker launch.
- Every model Tau sends data to is named in the user's config.
- A renamed key still fails with instructions, so users learn what to change.

### Negative

- A misspelled key only warns, so the feature runs without that setting until the user reads the
  warning.
- Users with `routes` must edit their user file once and add `classifier`.
- Each feature must read entries one at a time instead of parsing its whole block up front.

## Alternatives considered

### Keep strict nested keys

Keep rejecting unknown keys inside each feature's block. Rejected because every new nested key
breaks every older checkout that shares the user file.

### Reject every unknown key

Reject unknown keys at every depth, top level included. Rejected because it catches typos at the
cost of blocking older checkouts as soon as the user file gains any key.

### Version the config file

Add a `version` field and migrate older files. Rejected because older checkouts still refuse a newer
version, and every user file would carry a field the user must maintain.

### Keep the classifier in code as an exception

Keep `typesafe/jev-latest` in code and record it as the only exception to
[ADR 0072](./0072-keep-model-defaults-out-of-code.md). Rejected because Tau would send worker briefs
to a model the user never chose.

### Keep the `routes` name

Keep `routes` to avoid editing existing user files. Rejected because the key is new and used in few
files, so renaming now costs one edit, and the plural name misleads every later reader.
