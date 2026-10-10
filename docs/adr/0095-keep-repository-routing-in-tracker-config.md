# ADR 0095: Keep repository routing in tracker config

**Date**: 2026-10-06\
**Status**: Accepted; unknown key handling superseded by
[ADR 0099 (Warn on unknown config keys and fail only the entry in use)](./0099-warn-on-unknown-config-keys-and-fail-only-the-entry-in-use.md)\
**Supersedes**:
[ADR 0085 (Group per-repository settings in the user config)](./0085-group-per-repository-settings-in-the-user-config.md),
except its `bulkRead` key handling, already superseded by
[ADR 0087 (Gather evidence with codemode)](./0087-gather-evidence-with-codemode.md)\
**Related**: [ADR 0061 (Layer Tau config from user and repository files)](./0061-layer-tau-config-from-user-and-repository-files.md),
[ADR 0082 (Own Linear conventions in one tracker skill)](./0082-own-linear-conventions-in-one-tracker-skill.md)

## Context

The tracker needs a repository's Linear team and optional project, plus a shared agent team.
`tracker.repositories` already supplies that route.
[ADR 0085](./0085-group-per-repository-settings-in-the-user-config.md) chose a grouped repository
map to prepare for QA, review, and slice settings. Moving tracker routing for those planned
consumers would require users to rewrite working config without changing where tickets go.

The same user file serves Tau checkouts in several worktrees. A config layout should meet a current
need before it makes those checkouts disagree about where to read a route.

## Decision

Keep repository routing under `tracker.repositories` in the user config, rather than moving it to
`repositories[owner/name].tracker`.

Each entry is keyed by the `origin` remote's `owner/name` and holds a required `team` and optional
`project`. `tracker.agentTeam` names the shared team for agent tickets. Only the user file may set
`tracker`, because it chooses where the manager writes. For example, in `~/.pi/agent/tau.json`:

```json
{
  "tracker": {
    "agentTeam": "AI",
    "repositories": {
      "sQVe/tau": { "team": "ME", "project": "Tau" },
      "sQVe/cape": { "team": "AB" }
    }
  }
}
```

Keep validation with the consumer, as in
[ADR 0061](./0061-layer-tau-config-from-user-and-repository-files.md). Unknown top-level keys stay
ignored; the tracker rejects unknown fields inside its own block. The removed `slice` key remains an
error that names `tracker.agentTeam` and `tracker.repositories`. Do not introduce
[ADR 0085](./0085-group-per-repository-settings-in-the-user-config.md)'s grouped map, shared key
registry, or planned QA, review, and slice settings without a concrete consumer need.

[ADR 0087](./0087-gather-evidence-with-codemode.md) still owns the removal of `bulkRead`. This
decision does not restore that key or change its handling.

## Consequences

### Positive

- Existing tracker config keeps routing tickets without a migration.
- A feature's config and validation stay together.
- Planned consumers do not dictate the shape of settings users already maintain.

### Negative

- Future features may need their own repository maps and repeat `owner/name` keys.
- Unknown top-level keys can hide typos because they remain ignored.

## Alternatives considered

### Group settings under one repository map

Move tracker routing to `repositories[owner/name].tracker`, as
[ADR 0085](./0085-group-per-repository-settings-in-the-user-config.md) chose. Rejected because the
migration serves planned consumers rather than a current routing need.

### Read both layouts

Accept both `tracker.repositories` and the grouped map. Rejected because competing routes would need
precedence rules and leave users unsure which entry controls writes.
