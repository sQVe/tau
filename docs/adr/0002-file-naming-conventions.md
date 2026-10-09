# ADR 0002: File and directory naming conventions

**Date**: 2026-04-10\
**Status**: Accepted\
**Related**: [ADR 0001 (Application structure)](./0001-application-structure.md)

## Context

[ADR 0001](./0001-application-structure.md) set the directory layout but left file names and
contents undecided. Files use different naming rules with no shared reference.

## Decision

Use the following naming rules for TypeScript, tests, docs, special files, and config. One rule for
TypeScript files makes names consistent, though it can be awkward for files with many classes.

### TypeScript source

- Use camelCase for `.ts` files, such as `configLoader.ts` and `workspaceState.ts`.
- Use PascalCase only when a file mainly exports one class with the same name. Tau rarely uses
  classes.
- `index.ts` contains real implementation. Do not use files that only re-export other modules, also
  called barrel files. Change the module structure if callers need one entry point.
- A module's `types.ts` holds its shared types, with the schemas and small helpers that belong to
  those types. Do not create a separate file for each type.

### Tests

- Name unit tests `foo.test.ts` next to `foo.ts`.
- Split a large test file by behavior, and keep the source name first: `recordsClaims.test.ts` tests
  claims in `records.ts`.
- Cross-module integration and end-to-end tests live under `tests/` with the same suffix.
- Mark the test type with a suffix, not with a directory. Tests that run a real Pi session or herdr
  use `.integration.test.ts`; unit tests may still use a temporary Git repository.
- Test helpers used by one extension live in its `fixtures/` directory. Helpers shared across
  extensions live in `tests/`.

### Documentation

- Use kebab-case under `docs/`, such as `application-structure.md`.
- ADRs also use the `NNNN-kebab.md` prefix.

### Special files

Uppercase filenames exist only when an external convention requires them: `LICENSE`, `README.md`,
`SKILL.md`, `TEMPLATE.md`. Explain which convention requires each new uppercase file.

### Config files

Root config files, such as `tsconfig.json`, follow the naming rules of their tools.

## Consequences

### Positive

- One rule per question a contributor might ask about file naming.
- The `index.ts` rule prevents files that only re-export other modules.
- `tests/` has a clear purpose before end-to-end tests arrive.

### Negative

- A growing module may need restructuring to avoid files that only re-export other modules.
- New uppercase file names need individual review.

## Alternatives considered

### Per-module style

Let each module choose its style. Rejected because file names become less consistent.
