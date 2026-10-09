# ADR 0085: Group per-repository settings in the user config

**Date**: 2026-10-03\
**Status**: Superseded\
**Superseded by**:
[ADR 0095 (Keep repository routing in tracker config)](./0095-keep-repository-routing-in-tracker-config.md);
`bulkRead` key handling superseded by
[ADR 0087 (Gather evidence with codemode)](./0087-gather-evidence-with-codemode.md)\
**Related**: [ADR 0061 (Layer Tau config from user and repository files)](./0061-layer-tau-config-from-user-and-repository-files.md),
[ADR 0063 (Narrow allowed models from the user file to the repository file)](./0063-narrow-allowed-models-from-user-to-repository.md),
[ADR 0071 (Set worker models in the user config)](./0071-set-worker-models-in-the-user-config.md),
[ADR 0082 (Own Linear conventions in one tracker skill)](./0082-own-linear-conventions-in-one-tracker-skill.md)

## Context

Each feature adds its own top-level key to `tau.json`: `profiles`, `bulkRead`, `browser`,
`allowedModels`, `tdd`, and `tracker`. The tracker added the first per-repository map,
`tracker.repositories`, keyed by the `origin` remote's `owner/name`.

Planned QA and review settings also differ by repository: how QA finds the app URL, a test account,
whether QA may write data, which review bots to request, and whether slices stack. Without one rule,
each new key picks its own place, its own repository map, and its own handling of unknown and
removed keys.

Every Tau session reads the same user file, including older Tau checkouts in other worktrees. A
trusted repository's `.pi/tau.json` already sets `tdd` and may narrow `allowedModels`
([ADR 0061](./0061-layer-tau-config-from-user-and-repository-files.md),
[ADR 0063](./0063-narrow-allowed-models-from-user-to-repository.md)).

## Decision

Per-repository settings live in the user file under `repositories["owner/name"]`. Each entry holds
one key per feature. Global settings stay at the top level. With one top-level `repositories` map,
the user edits one place per repository, and each feature keeps its own key inside the entry.

### Placement

| Key                                                                        | File                            | Scope          |
| -------------------------------------------------------------------------- | ------------------------------- | -------------- |
| `profiles`                                                                 | user                            | global         |
| `bulkRead`                                                                 | user                            | global         |
| `browser`                                                                  | user                            | global         |
| `allowedModels`                                                            | user, then repository narrows   | global         |
| `tracker.agentTeam`                                                        | user                            | global         |
| `tdd`                                                                      | user, then repository overrides | global         |
| `repositories[...].tracker` (`team`, `project`)                            | user                            | per repository |
| `repositories[...].qa` (app URL lookup, test account command, data writes) | user                            | per repository |
| `repositories[...].reviews` (review bots)                                  | user                            | per repository |
| `repositories[...].slice` (stack default)                                  | user                            | per repository |

- `.pi/tau.json` sets only `tdd` and `allowedModels`. A repository file that sets any other key is
  an error that names the file.
- A per-repository key appears only inside a `repositories` entry, never at the top level. A global
  key appears only at the top level.
- The top-level `slice` key stays removed. Only `repositories[...].slice` is read.
- `qa.testAccountCommand` names a command that prints the test account, as `browser.loginCommand`
  names a command. The file holds no password.

### Repository identity

- Tau names the current repository by the `origin` remote's `owner/name` and matches entries without
  regard to case.
- Only a `github.com` remote names a repository. A remote on another host applies no entry, so a
  same-named repository elsewhere never receives another repository's QA account.
- Two entries that differ only in case are an error.
- Without an `origin` remote, no entry applies and only global settings are read.

### Naming

- Each feature owns one camelCase key, named after the feature. No feature reads another feature's
  key.
- A feature that needs both global and per-repository settings splits them by key, as the tracker
  splits `tracker.agentTeam` from `repositories[...].tracker`.

### Validation

- One module lists every top-level key, every key a `repositories` entry may hold, and which file
  may set each.
- Each feature rejects unknown keys inside its own block. The error names the file and the field and
  lists the known keys.
- In the user file, an unknown top-level key or `repositories` entry key produces one warning per
  session that names the key and the file. Tau keeps reading the other keys. In `.pi/tau.json`, an
  unknown key is an error, as every key other than `tdd` and `allowedModels` is.
- A known key in the wrong place, such as a top-level `qa` or `repositories[...].tdd`, is an error
  that says where to move it.
- A removed or renamed key stays on a list of removed keys with a message that says what to set
  instead. The list names the feature that owns each key. Only that feature fails with the message,
  so an old tracker key never blocks model selection.

## Consequences

### Positive

- Adding a repository means one entry in one file.
- New features have a fixed place for global and per-repository keys.
- An older Tau checkout keeps working when the user file gains a new key.
- A renamed key fails with instructions instead of being ignored.

### Negative

- A typo in a top-level key only warns, so the feature runs with its defaults until the user reads
  the warning.
- A team cannot share QA or review settings through the repository. Each user copies them into their
  own user file.
- QA needs a command, such as a password manager call, to read the test account.
- A repository on another host, or in a GitLab subgroup, cannot have settings until keys gain a
  host.
- `tracker.repositories` moves with no alias, so existing user files need a one-time edit. Older Tau
  checkouts lose tracker routing after the edit until they update.

## Alternatives considered

### One repository map per feature

Use one repository map per feature, such as `tracker.repositories` and `qa.repositories`. Rejected
because adding a repository means editing every feature's map, and the same `owner/name` repeats in
each.

### Per-repository settings in `.pi/tau.json`

Put per-repository settings in a checked-in `.pi/tau.json`. Rejected because the user works in
repositories they do not own and cannot add a file to. The repository file also needs project trust.

### Reject unknown top-level keys

Reject unknown top-level keys. Rejected because an older Tau checkout would fail as soon as the
shared user file gained a key that a newer Tau reads.

### Host in each repository key

Put the host in each repository key, such as `github.com/sQVe/tau`. Deferred because every current
entry is on GitHub, and longer keys buy nothing until a repository on another host needs settings.
