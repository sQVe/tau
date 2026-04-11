# ADR 0001: Application structure

- Status: Accepted
- Date: 2026-04-10

## Context

Tau needs a layout rule before contributors and extensions multiply. Four pressures:

- `extensions/` sits outside `src/`, leaving "where does application code live" ambiguous.
- Directory names drift between kebab-case and camelCase with no stated rule.
- Generic names like `rules/` overload as the codebase grows.
- Pi exposes four surface concepts (commands, events, tools, skills) with no fixed home.

## Options considered

- **Flat root with separate top-level dirs** (`extensions/`, `src/`, `skills/`, `rules/`). Current
  state. Mixes application code with tool config; no single source of truth.
- **Single `src/` umbrella with skills nested inside.** Clean, but fights Pi: Pi discovers skills
  from a top-level directory declared in `package.json`.
- **Single `src/` umbrella, skills at package root.** Aligns with Pi's discovery model and gives one
  answer for application code.

## Decision

All application code lives under `src/`. Skills sit at the package root because Pi discovers them
from a directory declared in `package.json`. `rules/` is renamed to `lint/` to name its intent.

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
  lint/                    # ast-grep YAML rules
  vendor/                  # third-party binary assets
```

### Where code goes

- `src/extensions/<name>/` owns feature-specific code: Pi wiring, state, types, rules, and surface
  handlers.
- `src/<primitive>/` owns code reused across extensions.
- `skills/` at the root owns SKILL.md files.
- `vendor/` at the root owns third-party binary assets (wasm, etc.).

If two extensions would reasonably share it, it is a primitive. If it belongs to one feature, it
lives in that extension.

### Extension shape

Every extension starts at two files:

- `index.ts` — Pi wiring.
- `types.ts` — domain types.

It grows only when a concept has more than one file. Typical additions: `state.ts`, `decision.ts`,
`rules/`, `commands/`, `events/`, `tools/`.

### Pi surface code

Commands, events, and tools are always owned by an extension. They register inside the extension's
default function via `pi.registerCommand`, `pi.on`, and `pi.registerTool`. No global handlers live
at the top level.

Skills are the exception: Pi discovers them from `skills/` at the root, declared in `package.json`.
Skills are SKILL.md files, not TypeScript modules.

`src/extensions/index.ts` stays thin: import extensions, install them at startup. No feature logic.

### Primitive shape

Primitives under `src/<primitive>/` follow the same minimal shape:

- `index.ts` — public API.
- `types.ts` — exported types.
- implementation files alongside.
- unit tests colocated as `foo.test.ts` next to `foo.ts`.

### Naming

- Directories under `src/` use camelCase.
- Unit tests colocate next to source.

## Tradeoffs

- - One rule for where application code lives and what an extension looks like.
- - Vocabulary matches Pi (`events/`, not `hooks/`).
- - The `rules/` collision goes away; `lint/` names its intent.
- − Moving `extensions/` under `src/` touches imports and tooling paths.
- − Primitive vs. extension is a judgment call on the margins.
