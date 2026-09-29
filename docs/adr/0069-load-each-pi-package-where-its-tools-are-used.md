# ADR 0069: Load each Pi package where its tools are used

- Status: Accepted
- Date: 2026-09-29

## Context

- A session sends the tools, guidelines, and skills of every package it loads on every request.
- Workers load the parent's settings and narrow them to their profile
  ([ADR 0067](./0067-give-workers-only-their-profile-tools-and-skills.md)). So the parent must load
  every package any profile needs, and it grows with each new profile.
- The parent rarely uses some of these packages. Over 492 parent sessions, `pi-codex-image-gen` was
  used in 1 and `pi-agent-browser-native` in 13. Together they add about 10k of the parent's 61.5k
  characters per request.
- Pi can load a package for one run with `-e <source>`, including its skills.
- Tau bundles `cc-safety-net` and `pi-web-access` because its own code depends on them.

## Options considered

- Keep loading every package in the parent's settings, and narrow workers with profile allowlists.
  The parent pays for every profile's tools, used or not.
- Deactivate unused tools in the parent with `setActiveTools`. An extension can activate its tool
  again, as the questionnaire does, and the parent still lists the package's skills.
- Filter a rarely used package out of the user's settings. The parent stops paying, but no profile
  can use the package either.
- Let a profile name the packages its workers need, and load them only in those workers. Choose this
  option.

## Decision

Load a Pi package in the session that uses its tools: Tau's bundle, the user's settings, or a worker
profile.

### Where a package belongs

- Bundle a package in `package.json` when Tau checks, adjusts, or requires it.
- Keep a package in the user's settings when the parent session uses its tools itself.
- Name a package in a worker profile when only that profile's workers use its tools. The worker
  loads it at launch, and the parent does not load it. The worker still loads every extension the
  parent loads, so adding a package never removes CC Safety Net or a model provider.

### Trimming the parent's prompt

- Count parent tool calls and skill reads from saved sessions before cutting.
- Move a package the parent rarely uses to a profile that does that work, or filter it out in the
  user's settings.
- When the cost sits in a package's own prompt text, file an issue with that package.

## Tradeoffs

- The parent's prompt stays the same size as profiles are added.
- The user keeps control of the packages the parent loads, and Tau works without them.
- Cost: the parent cannot call a profile's tools directly. It must start a worker for that work.
- Cost: a profile gets every tool and skill of the packages it names. Its tool allowlist narrows the
  tools, but not the skills.
- Cost: a worker launch fails when a named package cannot be installed or loaded.

## See also

- [ADR 0067: Give workers only their profile's tools and skills](./0067-give-workers-only-their-profile-tools-and-skills.md)
- [ADR 0028: Keep worker control in the parent](./0028-keep-worker-control-in-the-parent.md)
