# ADR 0141: Load coding guides from stomme

**Date**: 2026-11-18\
**Status**: Accepted\
**Related**: [ADR 0066 (Add Tau's prompt text to Pi's append section)](./0066-add-taus-prompt-text-to-pis-append-section.md),
[ADR 0067 (Give each worker profile one loadout of tools, skills, instruction sets, and packages)](./0067-give-workers-only-their-profile-tools-and-skills.md),
[ADR 0131 (Load language rules on first file access)](./0131-load-language-rules-on-first-file-access.md)

## Context

The coding rules live in stomme. A project that adopts stomme pins a version in `stomme.toml` and
syncs the general, language, and layer guides into `docs/stomme/`. A second copy of the rules in Tau
would drift from the version a project pins, and an agent would follow rules the project's checks do
not enforce.

A project can change its pin, its layers, or its synced guides while a Pi session runs. The main
session and its workers must send the same rules for one project, or a worker reviews code by rules
the manager never saw.

## Decision

The `coding` instruction set loads the stomme guides of the working directory's project instead of a
file in Tau. The set keeps its name, so profiles and saved loadouts stay valid.

### What loads

- In a project with `stomme.toml`, the set loads the general guide, the declared language guide, and
  the guides of the selected layers from the project's `docs/stomme/`.
- Without `stomme.toml`, the set loads the general guide bundled with Tau. Language guides then load
  on first file access ([ADR 0131](./0131-load-language-rules-on-first-file-access.md)).
- The text names the stomme version and the guide folder. Each guide follows a `Source:` line, so
  its relative links resolve. A project guide's line names its path under `docs/stomme/`. A bundled
  guide's line names its real path in Tau's bundle.

### Which record shapes it reads

- Tau reads both shapes of the sync record in `docs/stomme/`: the stomme 0.1.0 shape, which has no
  `schema`, and the `schema = 1` shape.
- Tau deletes the 0.1.0 shape reader once no adopted project pins stomme 0.1.0. Tau and greppa pin
  it today.

### When it loads

- Tau reads the guides once per Pi run, on `before_agent_start`. A run never reads them again
  between model calls, so one run never mixes two versions.
- The next run reads them again, so a changed pin, layer, or guide reaches it without a restart.
- The main session and each worker use one reader, so both send the same text for one project.

### A broken installation

- When the project's guides cannot be used, the set sends one line: Tau could not load the stomme
  coding guides, the reason, and an instruction to tell the user before changing code.
- Tau shows an error notice with the reason once per new reason. A usable run clears it. Only a
  session that loads the coding set shows it, so a worker without `coding` stays quiet.
- A broken project never falls back to the bundled guides.

## Consequences

### Positive

- The agent follows the rules the project pins and checks.
- A project change reaches the next run of every session and worker.
- A broken installation is visible to the user and to the agent.

### Negative

- Each run reads and hashes the guides again.
- A broken installation leaves the agent without coding rules until the user fixes it.
- The prompt grows with the size of the guides the project selects.

## Alternatives considered

### Keep a coding file in Tau

Keep a coding instructions file in Tau next to the stomme guides. Rejected because two copies drift,
and a project's checks enforce only its pinned version.

### Read the guides once per session

Read the guides at session start and keep them. Rejected because a sync or pin change during a
session would not reach the agent until a restart.

### Fall back to the bundle when the project is broken

Load Tau's bundled guides when the project's guides fail. Rejected because the bundle can hold a
different version than the project pins, and the agent would follow rules the project does not use.
