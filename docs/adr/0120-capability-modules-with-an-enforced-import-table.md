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

Tau adopts [shared ADR 0002](../stomme/shared/adr/0002-capability-modules.md) as its default for
capability modules, the import table, and dependency direction, and
[shared ADR 0003](../stomme/shared/adr/0003-owner-folders-and-file-names.md) for folders, entry
files, and file names. Shared code under `src/` follows them, except for the differences below. The
module list and import table live in `stomme.toml`.

### Differences from shared ADR 0002

Tau differs from shared ADR 0002 in two places today.

1. **The table is mirrored.** Tau keeps the module list and import table twice: as `[modules.*]` in
   `stomme.toml`, and as `moduleList` and `importTable` in `lint/rules/moduleBoundaries.ts`. The
   `tau/module-boundaries` rule enforces the second copy, because `@sqve/stomme-ts-imports` does not
   ship yet. `tests/stommeModules.test.ts` keeps the two copies equal. The mirror ends when Tau
   adopts that package.
2. **Some I/O modules import each other directly.** Shared ADR 0002 says I/O modules use pure
   modules, and reach each other through records of functions. The import table allows the edges
   below between two I/O modules.

A module is an I/O module when at least one of its files reads or writes the filesystem, starts a
process, uses the network or a socket, reads the clock, the environment, or randomness (such as
`Math.random()` or `randomUUID()`), calls a model or sets a timer, sends a message into the Pi
session, or draws the terminal UI. A module that runs a command through an injected `exec` function
starts a process, so it is an I/O module.

In this section, a pure module is a module with no I/O file. It is not the same as a module in
`pureModules`, which makes pure decisions.

The pure modules are `errors`, `handoverSender`, `judgeSchema`, `prose`, `schema`, `sessionMessage`,
`shell`, `shellScript`, `tabName`, and `wrapperAnalysis`. None of their files does I/O by the
criterion above. Every other module in `importTable` is an I/O module. Each of its edges to a pure
module follows the shared rule and is not listed.

`schema` keeps one exception to the no-effect rule: `strictToolRegistration` replaces `registerTool`
on the API it is given and records the APIs it has installed on. The import table may only shrink,
so a new module is not an option. `tests/pureModuleRegistry.ts` records the exception, and the rest
of the module still makes pure decisions.

`questionGate` is an I/O module because its judges call models and set timers. It imports no I/O
module, so it has no line below.

Each line names a module and the I/O modules it may import:

- `checkRecord`: `git`, `record`
- `classifier`: `config`
- `config`: `role`
- `dialog`: `role`
- `fileLock`: `process`
- `github`: `command`, `git`
- `hc`: `command`
- `improvement`: `command`, `fileLock`, `git`, `github`, `record`, `tauDirectory`
- `inbox`: `fileLock`, `hc`, `record`, `wake`
- `linear`: `command`
- `piStart`: `command`, `config`, `git`
- `record`: `tauDirectory`
- `reviewBots`: `command`, `config`, `github`
- `reviewCapture`: `command`, `git`, `github`, `record`, `tauDirectory`
- `tauDirectory`: `git`
- `verification`: `record`, `tauDirectory`

This list records deviations, as shared ADR 0002's "Existing projects" section allows, and it may
only shrink. That section lets a project record violations in `stomme.toml`. This list sits in this
ADR as prose. `stomme.toml` has no `[[violations]]` entries for these edges, and the `imports` lists
of its `[modules.*]` tables allow them. No check keeps this list equal to `importTable`, so a change
to the table updates the list in the same commit until the mirror ends.

### Tau's structure

- Feature code stays in `src/extensions/<feature>/`.
- Shared modules never import extensions, and no module imports `src/tau.ts` or `src/tau/tau.ts`.
  Extensions import shared modules and never import each other.
- `src/tau.ts` is the package entry and selects the registration. `package.json` points
  `pi.extensions` at that file, because Pi loads every `.ts` file of a folder it scans. The entry
  imports `src/tau/tau.ts`, which installs every extension, so only the entry may import the
  registration owner and only the registration owner may import extensions. The `tau` module has no
  import-table row. `src/tau/tauSelection.ts` picks the artifact or the source registration,
  `src/tau/tauArtifact.ts` holds the artifact key and path, and `src/tau/tau.ts` registers the
  extensions. `src/` has no `index.*` files and no barrel files.
- `src/extensions/` and `src/skills/` group files and are not modules.
- Other modules import a folder module through its entry file. A module may list extra public files
  in `stomme.toml`. An `eslint/no-restricted-imports` override in `vite.config.ts` lists Tau's extra
  public files, and tests and fixtures may import private files. Do not add shared `types.ts` files.
- Register a module that makes pure decisions in `pureModules` in `tests/pureModuleRegistry.ts`. The
  check fails the suite when a registered module does a runtime import of an unregistered module,
  imports dynamically, reads the clock, randomness, or the environment, or assigns a function to a
  property of an imported, parameter, or global object. The caller reads those values and passes
  them in as facts. `pureLibraries` in the same file lists the outside libraries each registered
  module may import. The check follows imports, not names, so renaming a file does not escape it.
- Keep `pureModules` in `tests/pureModuleRegistry.ts` and the module list and each module's public
  files in `lint/rules/moduleBoundaries.ts` sorted and free of duplicates, as
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
- The mirrored table can drift until `@sqve/stomme-ts-imports` replaces it. A test catches a
  difference between the two copies.
- The edges listed above stay allowed between I/O modules until each is removed.

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
