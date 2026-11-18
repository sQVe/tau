# ADR 0003: Owner folders, entry files, and file names

**Date**: 2026-11-15\
**Status**: Accepted\
**Related**: [ADR 0002 (Capability modules with a project-owned import table)](./0002-capability-modules.md)

## Context

[ADR 0002](./0002-capability-modules.md) decides which modules exist and which may use which. It says
nothing about how code is arranged inside a module. Without a rule, features go into a few central
files.

Agents write most features as slices that run in parallel branches. When every slice edits the same
central file, the branches conflict there, and a reader must scan one long file to find one feature.
The conflicts come from shared editing paths, not from size.

File names that mix word orders inside one module hide which file is the entry and which files
belong together. A strict rule that puts the owner noun first in every name fixes mixed modules, but
it makes some established names worse. A name such as `incompleteReport` becomes `reportIncomplete`,
and a reader can no longer tell the owner from the name.

## Decision

Each module grows from a flat file into a folder with an entry file, owner behavior lives in private
files that share the owner's noun, and no module has a catch-all file.

### Folders and entry files

- A module is a flat file until it has two production source files. Then it becomes a folder whose
  entry file is named after the folder. Count production files only; tests and fixtures do not
  count.
- In Rust, the entry file `foo.rs` sits beside the folder `foo/`. Never create `foo/mod.rs`. In
  TypeScript, the entry file is `foo/foo.ts`. Source folders hold no `index` files.
- Other modules use a folder module through its entry file. A module may name extra public files that
  other modules already depend on, in a bounded field in `stomme.toml`. Tests may use private files.
- A folder that only groups modules is not a module and has no entry file.

### Owners and coordinators

- An owner is a user-facing noun for behavior that changes on its own, whether an entity or a
  capability. Use the same noun for it in every module.
- Infrastructure that belongs to no feature has its own owner noun, such as `lock` or `clock`.
- An owner may have several files, one per behavior that changes on its own, such as parsing,
  transitions, and effects. Keep a resource's lifetime or one state machine in one file.
- An entry file is the module's coordinator. It holds the public API, dispatch, lifecycle, and the
  order that must stay central, and no owner-specific behavior. A feature edits it only to register a
  command, an action, or a layout slot, or to change a public contract.

### No catch-all files

Do not add `types`, `utils`, `helpers`, `common`, or barrel files. Do not split a module by kind of
code, such as `types`, `handlers`, and `parsers`. Code lives with the owner it serves.

### File names

- Use each language's normal case: snake_case for Rust files, and camelCase for TypeScript files.
  Use PascalCase for a TypeScript file only when it mainly exports one class with the same name.
- Use one noun for one concept inside a module. Files about the same concept form one local family
  that shares its noun, such as `report` and `reportIncomplete`, or `verify` and `verifyDecisions`.
- No file reverses its module's name, such as `captureReview` beside `reviewCapture`.
- A noun alone names what the file holds, such as `record`. A plural noun alone names a collection.
- Keep an established domain phrase when it matches a config key or an exported concept, such as
  `allowedModels`. The owner noun need not come first in every name.
- Rename an existing file only for a real ambiguity, in its own small change, after checking active
  unlanded work and the file's importers.
- Use kebab-case under `docs/`. ADRs use the `NNNN-kebab.md` form.
- Use uppercase file names only when an outside convention requires them, such as `LICENSE`,
  `README.md`, and `TEMPLATE.md`.

## Consequences

### Positive

- Parallel slices for different owners edit different files, so they conflict less.
- The path shows a module's size, and a reader can tell its entry from its other files.
- A reader finds a feature by its noun, and finds one concept under one noun.
- Coordinators stay short because they hold dispatch and ordering only.

### Negative

- One feature spans several small files, so a change opens more files.
- A module's second file moves its first file, which touches every use of it.
- Each new command or layout slot still edits its coordinator once to register.
- Which noun names a concept is a judgment call, and two slices can pick different nouns for one
  feature.

## Alternatives considered

### Keep growing the central files

Keep one file per module and rely on review to keep it readable. Rejected because every parallel
slice would edit the same blocks.

### Split by kind of code

Use files such as `types`, `handlers`, and `parsers` inside each module. Rejected because one feature
would spread across every file, and a shared `types` file becomes a catch-all.

### One folder per feature across modules

Use one folder per feature that holds its store, command line, and UI code. Rejected because pure and
UI code would share a folder, and the import table could no longer tell them apart.

### Owner noun first in every file name

Require `<owner><job>` for every private file. Rejected because it made established names worse, such
as `incompleteReport` turning into `reportIncomplete`, while the local-family rule already keeps one
concept's files together.

### Rename on touch

Rename a file to the current rules whenever a change touches it. Rejected because a rename changes
importers and tests, so it widens the merge surface of the very feature work that overlaps other
branches.
