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

Shared code under `src/` forms a closed list of capability modules, and the lint rule
`tau/module-boundaries` in `lint/rules/moduleBoundaries.ts` allows one import direction between
them, set by an import table. A new shared file must join a listed module, or the change adds a
module to the list and a row to the table. Naming the modules and their edges in one place gives
every agent the same answer to "where does this go" and "may this import that".

### Target modules and import table

The target shared modules and the modules each may import:

| Module          | May import                                          |
| --------------- | --------------------------------------------------- |
| `errors`        | nothing                                             |
| `schema`        | nothing                                             |
| `command`       | `schema`                                            |
| `instructions`  | nothing                                             |
| `herdr`         | nothing                                             |
| `codemode`      | nothing                                             |
| `shell`         | nothing                                             |
| `skillTools`    | nothing                                             |
| `worker`        | `schema`                                            |
| `dialog`        | `worker`                                            |
| `process`       | `errors`                                            |
| `fileLock`      | `errors`, `process`, `schema`                       |
| `git`           | `errors`                                            |
| `config`        | `errors`, `schema`                                  |
| `linear`        | `command`, `errors`                                 |
| `github`        | `command`, `errors`, `git`, `schema`                |
| `tauDirectory`  | `errors`, `git`                                     |
| `record`        | `errors`, `schema`, `tauDirectory`                  |
| `checkRecord`   | `errors`, `git`, `record`                           |
| `reviewCapture` | `errors`, `git`, `record`, `schema`, `tauDirectory` |

`skillTools`, `tauDirectory`, and `reviewCapture` keep the edges they have today, renamed to the
target modules. Shared modules never import extensions, and no module imports `src/tau.ts`.
Extensions import shared modules and never import each other.

The rule's table lists only these modules, so a new flat file under `src/` needs a new row.

### Changing the table

An edge that keeps the table's directions is an edit to the rule's table and this ADR's table, which
a structure test keeps equal. An edge that reverses a listed direction needs a new ADR. When the
rule reports an import, change the table or the module list instead of silencing the rule.

### Placement and structure

- Application code lives under `src/`. A skill folder stays a public identifier, so moving its
  parent folder does not rename it.
- Feature code stays in `src/extensions/<feature>/`. Code moves to shared `src/` only once two
  extensions need it. The import rule does not enforce this threshold.
- `src/tau.ts` is the package entry and installs every extension. `package.json` points
  `pi.extensions` at that file, because Pi loads every `.ts` file of a folder it scans. `src/` has
  no `index.*` files and no barrel files.
- A module is a flat file until it has two production source files. Then it becomes a folder whose
  entry file is named after the folder. Count production files only; tests, `fixtures/`,
  `profiles/`, and `snippets/` do not count. A flat module keeps its test beside it.
- `src/extensions/` and `src/skills/` group files and are not modules.
- Other modules import a folder module through its entry file. A module may list extra public files
  that other modules already depend on, such as `controller.ts`, `record.ts`, and `budget.ts` in
  `subagents/controller/`. An `eslint/no-restricted-imports` override in `vite.config.ts` lists
  them, and tests and fixtures may import private files. Do not add shared `types.ts` files.
- Tau requires no interfaces for module boundaries.
- Register a module that makes pure decisions in `pureModules` in `tests/structure.test.ts`. The
  check fails the suite when a registered module does a runtime import of an unregistered module,
  imports dynamically, or reads the clock, randomness, or the environment. The caller reads those
  values and passes them in as facts. The one outside library a registered module may import is
  `typebox/value` in `src/schema.ts`, whose schema checks are pure. The check follows imports, not
  names, so renaming a file does not escape it.

### File names

- Use camelCase for `.ts` files. Use PascalCase only when a file mainly exports one class with the
  same name.
- Use one noun for one concept inside a module, and keep files about the same concept in one local
  family, such as `report*` or `verify` with `verifyDecisions`.
- No file reverses its module's name, such as `captureReview.ts` beside `reviewCapture.ts`. This
  covers private files and extra public files.
- A noun alone names what the file holds, such as `record.ts`. A plural noun alone names a
  collection.
- Keep an established domain phrase when it matches a config key or exported concept, such as
  `allowedModels.ts` or `requiredFor.ts`.
- Name a unit test `foo.test.ts` beside `foo.ts`. Split a large test file by behavior and keep the
  source name first. Cross-module tests live in `tests/`. Mark tests that run a real Pi session or
  herdr with `.integration.test.ts`.
- Rename an existing file only for a real ambiguity, in its own small change, after checking active
  unlanded work and the file's importers. Squash-merged branch refs are not active work.
- Use kebab-case under `docs/`. ADRs use the `NNNN-kebab.md` form.
- Use uppercase file names only when an external convention requires them, such as `LICENSE`,
  `README.md`, `SKILL.md`, and `TEMPLATE.md`.
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

### Keep separate rules per concern

Keep the placement, naming, purity, and extension rules as separate records, with the extension
boundary as the only import rule. Rejected because no record named the shared modules, so shared
files kept importing each other in any direction.

### Import table in review only

Describe the allowed edges in a document and rely on review. Rejected because agents copy nearby
code, and a rule without a check drifts.

### Owner noun first in every private file name

Rejected. It fixed the mixed modules but made established names worse, and the owner of a file such
as `compactionWorkers.ts` is unclear without reading it. Phi uses this rule because its files belong
to a few user-facing nouns, such as pane and tab. Tau's modules own tools, workers, records, and
profiles.

### Rename on touch

Rejected. A rename changes importers, tests, and registry entries, so it widens the merge surface of
the very feature work that overlaps other branches.
