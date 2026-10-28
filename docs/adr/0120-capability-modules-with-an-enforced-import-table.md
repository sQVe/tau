# ADR 0120: Capability modules with an enforced import table

**Date**: 2026-10-21\
**Status**: Accepted\
**Supersedes**: [ADR 0001 (Application structure)](./README.md#retired),
[ADR 0002 (File and directory naming conventions)](./README.md#retired),
[ADR 0057 (Enforce pure decision modules from a registry)](./README.md#retired),
[ADR 0079 (Grow modules from flat files)](./README.md#retired)\
**Related**: [ADR 0055 (Record Tau coding conventions in `AGENTS.md`)](./0055-record-tau-coding-conventions-in-agents-md.md),
[ADR 0109 (Keep action behavior out of extension roots and name one concept one way)](./0109-keep-action-behavior-out-of-extension-roots.md)

## Context

Agents build features as slices in parallel branches. Each slice adds the shared helper it needs, so
the same helper appears in several flat files, and shared files import each other in whatever
direction was convenient. A reader cannot tell which shared file owns a concept or which files may
depend on it.

The earlier rules were spread over several records: where code lives, how files are named, which
modules stay pure, and which extensions may not import each other. None of them named the shared
modules or the direction of their imports. A rule that no check enforces drifts, because agents copy
nearby code.

## Decision

Shared code under `src/` forms a closed list of capability modules, and the lint rule
`tau/module-boundaries` in `lint/rules/moduleBoundaries.ts` allows one import direction between
them, set by an import table. A new shared file must join a listed module, or the change adds a
module to the list and a row to the table. Naming the modules and their edges in one place gives
every agent the same answer to "where does this go" and "may this import that".

### Target modules and import table

The target shared modules and the modules each may import:

| Module          | May import                                |
| --------------- | ----------------------------------------- |
| `errors`        | nothing                                   |
| `schema`        | nothing                                   |
| `command`       | `schema`                                  |
| `instructions`  | nothing                                   |
| `herdr`         | nothing                                   |
| `codemode`      | nothing                                   |
| `shell`         | nothing                                   |
| `skillTools`    | nothing                                   |
| `worker`        | `schema`                                  |
| `dialog`        | `worker`                                  |
| `process`       | `errors`                                  |
| `git`           | `errors`                                  |
| `config`        | `errors`, `schema`                        |
| `linear`        | `command`, `errors`, `schema`             |
| `github`        | `command`, `errors`, `git`, `schema`      |
| `tauDirectory`  | `errors`, `git`                           |
| `record`        | `errors`, `schema`, `tauDirectory`        |
| `checkRecord`   | `errors`, `record`, `schema`              |
| `reviewCapture` | `errors`, `git`, `schema`, `tauDirectory` |

`skillTools`, `tauDirectory`, and `reviewCapture` keep the edges they have today, renamed to the
target modules. Shared modules never import extensions, and no module imports `src/tau.ts`.
Extensions import shared modules and never import each other.

The rule's table starts from today's flat files and shrinks as modules form. Each slice that merges
flat files into a target module replaces their rows with the module's row. When the last flat file
is gone, only the target modules remain.

### Changing the table

An edge that keeps the table's directions is an edit to the rule's table and nothing else. An edge
that reverses a listed direction needs a new ADR. When the rule reports an import, change the table
or the module list instead of silencing the rule.

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
- Name a unit test `foo.test.ts` beside `foo.ts`. Split a large test file by behavior and keep the
  source name first. Cross-module tests live in `tests/`. Mark tests that run a real Pi session or
  herdr with `.integration.test.ts`.
- Use kebab-case under `docs/`. ADRs use the `NNNN-kebab.md` form.
- Use uppercase file names only when an external convention requires them, such as `LICENSE`,
  `README.md`, `SKILL.md`, and `TEMPLATE.md`.
- Naming inside a module, and the lists that must stay sorted, follow
  [ADR 0109](./0109-keep-action-behavior-out-of-extension-roots.md) and
  [ADR 0055](./0055-record-tau-coding-conventions-in-agents-md.md).

## Consequences

### Positive

- One list and one table answer where shared code goes and which modules may depend on it.
- The rule reports a wrong import at lint time, so the structure does not rely on review.
- The path shows a module's size, and each file name says which module it belongs to.

### Negative

- A new shared file needs a module and a table row, which adds a step for small helpers.
- A module's second file moves its first file, which touches every import of it.
- Until the flat files merge, the table is long and lists modules that will disappear.

## Alternatives considered

### Keep separate rules per concern

Keep the placement, naming, purity, and extension rules as separate records, with the extension
boundary as the only import rule. Rejected because no record named the shared modules, so shared
files kept importing each other in any direction.

### Import table in review only

Describe the allowed edges in a document and rely on review. Rejected because agents copy nearby
code, and a rule without a check drifts.
