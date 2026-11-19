# ADR 0002: Capability modules with a project-owned import table

**Date**: 2026-11-15\
**Status**: Accepted\
**Related**: [ADR 0003 (Owner folders, entry files, and file names)](./0003-owner-folders-and-file-names.md),
[ADR 0006 (Side effects as records of functions)](./0006-side-effect-records.md)

## Context

Agents build features as slices in parallel branches. Each slice adds the shared helper it needs, so
the same helper appears in several files, and shared files import each other in whatever direction
was convenient. A reader cannot tell which file owns a concept or which files may depend on it.

Folders such as `domain/`, `application/`, and `adapters/` describe layers, but they do not say who
owns a job. A rule that lives only in prose drifts, because agents copy nearby code. Boundaries need
a mechanical check.

Each project has its own capabilities, so the shared rules cannot name the modules. They can only say
how a project names them and which directions they may take.

## Decision

Shared code in a project forms a closed list of capability modules, and an import table owned by the
project allows one direction between them. The project keeps the list and the table in a bounded
field in `stomme.toml`, and a check refuses any use that crosses the table. Naming the modules and
their edges in one place gives every agent the same answer to "where does this go" and "may this use
that".

### Modules and the table

- A capability module owns one job, such as a store, a parser, or a client for an outside service.
  Its name is the project's choice.
- The table lists each module and the modules it may use. A module not in the table has no shared
  code to offer, so a new shared file joins a listed module or the change adds a row.
- An edge that keeps the table's directions is a table edit. An edge that reverses a listed direction
  needs a project ADR.
- When the check reports a use, change the table or the module list instead of silencing the check.

### Dependency direction

- Modules that hold pure rules use no I/O module and do no I/O of their own. The caller reads the
  clock, randomness, and the environment and passes them in as facts.
- I/O modules use pure modules, not each other. They reach each other through records of functions,
  as [ADR 0006](./0006-side-effect-records.md) describes.
- A module names another module by its own path. In Rust, it uses `crate::<module>` paths, no items
  from the crate root, and no `crate::*` glob. In TypeScript, it imports a module through its entry
  file and uses no barrel file. The check then sees every use between modules.
- Module boundaries need no interfaces or traits.

### Code placement

- Feature code stays with its feature. Code moves to a shared module only once two existing
  consumers need it.
- Types live in the module that owns them. Do not add a shared `types`, `utils`, or re-export-only
  module.

### Existing projects

A project that adopts these rules may record its current violations by path and rule in a bounded
field in `stomme.toml`. The list may only shrink.

## Consequences

### Positive

- One list and one table answer where shared code goes and which modules may depend on it.
- The check refuses a wrong use at check time, so the structure does not rely on review.
- Pure modules run in tests without fakes.

### Negative

- A new shared module or edge needs a table change, which adds a step for small helpers.
- The Rust check reads `crate::` and `super::` paths. It cannot see paths through another crate's
  name or I/O reached through `std`.
- A project with existing violations carries a list until it removes them.

## Alternatives considered

### Layer folders

Use layer folders such as `domain/`, `application/`, and `adapters/`. Rejected because the folder
names say little about who owns a job, and they invite empty scaffolding.

### Import rules written only in docs

Describe the allowed edges in a document and rely on review. Rejected because agents copy nearby
code, and a rule without a check drifts.

### One shared list of module names

Let stomme name the capability modules every project must have. Rejected because projects own
different capabilities, and a shared list would force names that fit no project.
