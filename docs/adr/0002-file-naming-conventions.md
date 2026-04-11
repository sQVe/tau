# ADR 0002: File and directory naming conventions

- Status: Approved
- Date: 2026-04-10

## Context

ADR 0001 settled directory layout. It did not cover file-level naming or organization. Several
conventions exist in practice; this ADR captures them in one place.

## Options considered

- **Per-module convention.** Each module picks its own style. Causes drift.
- **One rule across TypeScript source.** Uniform and scannable; occasionally awkward for class-heavy
  files.

## Decision

### TypeScript source

- camelCase for all `.ts` files (`configLoader.ts`, `workspaceState.ts`).
- PascalCase only when a file's primary export is a single class matching the file name. Tau rarely
  uses classes.
- `index.ts` contains real implementation. Barrel files (re-export only) are disallowed. If a module
  needs an aggregated surface, restructure it.
- `types.ts` next to `index.ts` holds the module's domain types. Single-type files do not earn their
  own file.

### Tests

- Unit tests colocate as `foo.test.ts` next to `foo.ts`.
- Cross-module integration and end-to-end tests live under `tests/` with the same suffix.
- Subdivide by test type as the suite grows (`tests/integration/`).

### Documentation

- Files under `docs/` use kebab-case (`application-structure.md`).
- ADRs also use the `NNNN-kebab.md` prefix.

### Special files

Uppercase filenames exist only when an external convention requires them: `LICENSE`, `README.md`,
`SKILL.md`, `TEMPLATE.md`. New uppercase files need a stated convention reason.

### Config files

Repository-root config (`.oxlintrc.json`, `tsconfig.json`, etc.) follows each tool's own convention.
Out of scope.

## Tradeoffs

- - One rule per question a contributor might ask about file naming.
- - The `index.ts` rule prevents barrel files from proliferating.
- - `tests/` has a stated purpose before end-to-end tests actually arrive.
- − The no-barrel rule may feel restrictive as a module grows; the mitigation is restructure, not
  relax.
- − Case-by-case uppercase filenames require judgment rather than a hard rule.

## See also

- [ADR-0001: Application structure](./0001-application-structure.md)
