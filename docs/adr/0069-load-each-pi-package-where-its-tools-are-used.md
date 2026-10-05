# ADR 0069: Load each Pi package where its tools are used

**Date**: 2026-09-29\
**Status**: Accepted\
**Related**: [ADR 0067 (Give workers only their profile's tools and skills)](./0067-give-workers-only-their-profile-tools-and-skills.md),
[ADR 0028 (Keep worker control in the parent)](./0028-keep-worker-control-in-the-parent.md)

## Context

A session sends the tools, guidelines, and skills of every package it loads on every request.
Workers load the parent's settings and narrow them to their profile
([ADR 0067](./0067-give-workers-only-their-profile-tools-and-skills.md)). So the parent must load
every package any profile needs, and it grows with each new profile.

The parent rarely uses some of these packages. The image and browser packages appeared in few saved
parent sessions, yet took about a fifth of every parent request.

Pi can load a package for one run with `-e <source>`, including its skills. Tau bundles
`cc-safety-net` and `pi-web-access` because its own code depends on them.

## Decision

Load a Pi package in the session that uses its tools: Tau's bundle, the user's settings, or a worker
profile. When a profile names the packages its workers need and only those workers load them, a
profile's packages stay out of the parent's prompt, and each profile keeps the packages it needs.

### Where a package belongs

- Bundle a package in `package.json` when Tau checks, adjusts, or requires it.
- Keep a package in the user's settings when the parent session uses its tools itself.
- Name a package in a worker profile when only that profile's workers use its tools. The worker
  loads it at launch, and the parent does not load it. The worker still loads every extension the
  parent loads, so adding a package never removes CC Safety Net or a model provider.

### Loading a profile's packages

- A profile's `packages:` setting lists package sources as `pi -e` takes them.
- Before it opens the worker's pane, the parent installs each package into Pi's temporary `-e`
  cache. An install failure stops the launch and names the package. When Pi installs at worker
  startup instead, a failure only shows as a worker that exited.
- The worker loads each package with `-e`, after Tau's worker extensions.
- A package that the user's or project's settings already load gets no `-e`, and the launch goes on.
  Loading it twice would leave the tool conflict to Pi's load order.

### Trimming the parent's prompt

- Count parent tool calls and skill reads from saved sessions before cutting.
- Move a package the parent rarely uses to a profile that does that work, or filter it out in the
  user's settings.
- When the cost sits in a package's own prompt text, file an issue with that package.

## Consequences

### Positive

- A new profile adds no package tools or skills to the parent's prompt. It still adds its name and
  description to the `subagent` tool.
- The user keeps control of the packages the parent loads, and Tau works without them.

### Negative

- The parent cannot call a profile's tools directly. It must start a worker for that work.
- A profile gets every tool and skill of the packages it names. Its tool allowlist narrows the
  tools, but not the skills.
- A worker launch fails when a named package cannot be installed or loaded.
- Pi keeps an unpinned npm package at the version it first cached. Pin a version to update it.

## Alternatives considered

### Load every package in the parent

Keep loading every package in the parent's settings, and narrow workers with profile allowlists.
Rejected because the parent pays for every profile's tools, used or not.

### Deactivate unused tools in the parent

Deactivate unused tools in the parent with `setActiveTools`. Rejected because an extension can
activate its tool again, as the questionnaire does, and the parent still lists the package's skills.

### Filter the package out of the user's settings

Filter a rarely used package out of the user's settings. Rejected because, although the parent stops
paying, no profile can use the package either.
