# ADR 0120: Capability modules with an enforced import table

**Date**: 2026-10-21\
**Status**: Accepted\
**Supersedes**: [ADR 0001 (Application structure)](./README.md#retired),
[ADR 0002 (File and directory naming conventions)](./README.md#retired),
[ADR 0057 (Enforce pure decision modules from a registry)](./README.md#retired),
[ADR 0079 (Grow modules from flat files)](./README.md#retired)\
**Related**: [ADR 0055 (Record Tau coding conventions in `AGENTS.md`)](./0055-record-tau-coding-conventions-in-agents-md.md),
[ADR 0109 (Keep action behavior out of extension roots)](./0109-keep-action-behavior-out-of-extension-roots.md)

## Context

Agents build features as slices in parallel branches. Each slice adds the shared helper it needs, so
the same helper appears in several flat files, and shared files import each other in whatever
direction was convenient. A reader cannot tell which shared file owns a concept or which files may
depend on it.

The earlier rules were spread over several records: where code lives, how files are named, which
modules stay pure, and which extensions may not import each other. None of them named the shared
modules or the direction of their imports. A rule that no check enforces drifts, because agents copy
nearby code.

File names once mixed word orders inside some modules. `reviewCapture/` held `reviewCapture.ts`
beside `captureReview.ts`, so a reader could not tell which file was the entry. Most modules used
one local pattern, often verb and decision pairs such as `verify.ts` and `verifyDecisions.ts`. A
strict owner-first rule made several real names worse. `incompleteReport` became `reportIncomplete`,
and `passiveWait` became `waitPassive`.

## Decision

Shared code under `src/` follows [shared ADR 0002](../stomme/shared/adr/0002-capability-modules.md)
for capability modules, the import table, and dependency direction, and
[shared ADR 0003](../stomme/shared/adr/0003-owner-folders-and-file-names.md) for folders, entry
files, and file names. The module list and import table live in `stomme.toml`. Until
`@sqve/stomme-ts-imports` ships, `tau/module-boundaries` in `lint/rules/moduleBoundaries.ts`
enforces the table, and `tests/stommeModules.test.ts` keeps the table and the rule's module list
equal.

### Tau's structure

- Feature code stays in `src/extensions/<feature>/`.
- Shared modules never import extensions, and no module imports `src/tau.ts`. Extensions import
  shared modules and never import each other.
- `src/tau.ts` is the package entry and installs every extension. `package.json` points
  `pi.extensions` at that file, because Pi loads every `.ts` file of a folder it scans. `src/` has
  no `index.*` files and no barrel files.
- `src/extensions/` and `src/skills/` group files and are not modules.
- Other modules import a folder module through its entry file. A module may list extra public files
  in `stomme.toml`. An `eslint/no-restricted-imports` override in `vite.config.ts` lists Tau's extra
  public files, and tests and fixtures may import private files. Do not add shared `types.ts` files.
- Register a module that makes pure decisions in `pureModules` in `tests/structure.test.ts`. The
  check fails the suite when a registered module does a runtime import of an unregistered module,
  imports dynamically, or reads the clock, randomness, or the environment. The caller reads those
  values and passes them in as facts. The outside libraries a registered module may import are
  `typebox` and `typebox/value` in `src/schema.ts` and `src/inbox/protocol.ts`, whose schema
  builders and checks are pure, and in `src/improvement/transcript.ts`, whose transcript state is a
  saved record checked by a schema, and `minimatch` in `src/extensions/tdd/inputGlob.ts`, which only
  compiles and matches strings, and `@xmldom/xmldom` in `src/extensions/tdd/runner/junit.ts`, which
  only parses a string into a document, and `node:path` in `src/extensions/tdd/runner/report.ts`,
  `src/extensions/tdd/runner/cargoInputFiles.ts`, `src/extensions/tdd/projectPath.ts`,
  `src/improvement/taskFacts.ts`, `src/improvement/taskMapping.ts`, and
  `src/improvement/writeDecision.ts`, which handle paths as strings without touching the filesystem.
  The check follows imports, not names, so renaming a file does not escape it.
- Keep `pureModules` in `tests/structure.test.ts` and the module list and each module's public files
  in `lint/rules/moduleBoundaries.ts` sorted and free of duplicates, as
  [ADR 0109](./0109-keep-action-behavior-out-of-extension-roots.md) says.

## Consequences

### Positive

- One list and one table answer where shared code goes and which modules may depend on it.
- The rule reports a wrong import at lint time, so the structure does not rely on review.
- The path shows a module's size, and each file name says which module it belongs to.
- A reader can tell the entry of a module from its other files, and finds one concept under one
  noun.

### Negative

- A new shared module needs a table row, which adds a step for small helpers.
- A module's second file moves its first file, which touches every import of it.
- Which noun names a concept still needs judgment in review. Only registry order is checked.

## Alternatives considered

[Shared ADR 0002](../stomme/shared/adr/0002-capability-modules.md) rejects layer folders, import
rules written only in docs, and one shared list of module names.

### Owner noun first in every private file name

Rejected. It fixed the mixed modules but made established names worse, and the owner of a file such
as `compactionWorkers.ts` is unclear without reading it. Phi uses this rule because its files belong
to a few user-facing nouns, such as pane and tab. Tau's modules own tools, workers, records, and
profiles.

### Rename on touch

Rejected. A rename changes importers, tests, and registry entries, so it widens the merge surface of
the very feature work that overlaps other branches.
