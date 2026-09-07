# ADR 0002: File and directory naming conventions

- Status: Accepted
- Date: 2026-04-10

## Context

- ADR 0001 set the directory layout but left file names and contents undecided.
- Files use different naming rules with no shared reference.

## Options considered

- Let each module choose its style. File names become less consistent.
- Use one rule for TypeScript files. Makes names consistent, but can be awkward for files with many
  classes.

## Decision

Use the following naming rules for TypeScript, tests, docs, special files, and settings.

### TypeScript source

- Use camelCase for `.ts` files, such as `configLoader.ts` and `workspaceState.ts`.
- Use PascalCase only when a file mainly exports one class with the same name. Tau rarely uses
  classes.
- `index.ts` contains real implementation. Do not use files that only re-export other modules, also
  called barrel files. Change the module structure if callers need one entry point.
- `types.ts` next to `index.ts` holds the module's types. Do not create a separate file for each
  type.

### Tests

- Name unit tests `foo.test.ts` next to `foo.ts`.
- Cross-module integration and end-to-end tests live under `tests/` with the same suffix.
- Add directories by test type as needed, such as `tests/integration/`.

### Documentation

- Use kebab-case under `docs/`, such as `application-structure.md`.
- ADRs also use the `NNNN-kebab.md` prefix.

### Special files

Uppercase filenames exist only when an external convention requires them: `LICENSE`, `README.md`,
`SKILL.md`, `TEMPLATE.md`. Explain which convention requires each new uppercase file.

### Config files

Root config files, such as `.oxlintrc.json` and `tsconfig.json`, follow the naming rules of their
tools.

## Tradeoffs

- One rule per question a contributor might ask about file naming.
- The `index.ts` rule prevents files that only re-export other modules.
- `tests/` has a clear purpose before end-to-end tests arrive.
- Cost: a growing module may need restructuring to avoid files that only re-export other modules.
- Cost: new uppercase file names need individual review.

## See also

- [ADR-0001: Application structure](./0001-application-structure.md)
