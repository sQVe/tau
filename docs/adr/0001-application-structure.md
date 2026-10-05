# ADR 0001: Application structure

**Date**: 2026-04-10\
**Status**: Accepted; layout, skills location, extension shape, and primitive shape superseded by
[ADR 0079 (Grow modules from flat files)](./0079-grow-modules-from-flat-files.md)\
**Related**: [ADR 0079 (Grow modules from flat files)](./0079-grow-modules-from-flat-files.md)

## Context

`extensions/` sits outside `src/`, so application code has two locations. Directory names mix
kebab-case and camelCase with no stated rule. Names like `rules/` do not say what their files
control.

Commands, events, tools, and skills need clear places in the project.

## Decision

Application code lives under `src/`, and skills stay at the package root for Pi discovery. This
matches how Pi finds skills and gives code one home.

```text
tau/
  skills/                  # Pi-discovered, declared in package.json
    <skillName>/
      SKILL.md
  src/
    extensions/
      index.ts             # imports and installs extensions
      <extensionName>/     # feature modules
    <primitiveName>/       # shared code composed by extensions
```

### Where code goes

- `src/extensions/<name>/` holds the code for one feature, including Pi setup, state, types, rules,
  and handlers.
- `src/<primitive>/` holds code shared by extensions.
- `skills/` at the root holds SKILL.md files.

A primitive is code that two or more extensions could share. Code for one feature stays in that
extension.

### Extension shape

Start each extension with two files:

- `index.ts` for Pi setup.
- `types.ts` for its types.

It grows only when a concept has more than one file. Common additions include `state.ts`,
`decision.ts`, `rules/`, `commands/`, `events/`, `tools/`.

### Pi commands, events, and tools

Each command, event, and tool belongs to an extension. Register them inside the extension's default
function via `pi.registerCommand`, `pi.on`, and `pi.registerTool`. No global handlers live at the
top level.

Skills are the exception: Pi discovers them from `skills/` at the root, declared in `package.json`.
Skills are SKILL.md files, not TypeScript modules.

`src/extensions/index.ts` stays thin: import extensions, install them at startup. No feature logic.

### Primitive shape

Shared code under `src/<primitive>/` follows the same layout:

- `index.ts` for the public API.
- `types.ts` for exported types.
- implementation files alongside.
- unit tests named `foo.test.ts` next to `foo.ts`.

### Naming

- Directories under `src/` use camelCase.
- Keep unit tests next to the code they test.

## Consequences

### Positive

- One rule for where application code lives and what an extension looks like.
- Vocabulary matches Pi (`events/`, not `hooks/`).

### Negative

- Moving `extensions/` under `src/` touches imports and tooling paths.
- Deciding whether code belongs in a shared module or one extension still needs judgment.

## Alternatives considered

### Keep the root directories

Keep `extensions/`, `src/`, `skills/`, and `rules/` at the root. Rejected because it mixes
application code with tool settings and leaves code in several places.

### Everything under `src/`

Put everything under `src/`, including skills. Rejected because, although it keeps code together, it
does not match Pi's discovery of skills from a root directory declared in `package.json`.
