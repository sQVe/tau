# ADR 0004: Shared roles, two languages, and framework layers

**Date**: 2026-11-15\
**Status**: Accepted\
**Related**: [ADR 0002 (Capability modules with a project-owned import table)](./0002-capability-modules.md)

## Context

Language, framework, and application shape are independent choices. A project can combine
frameworks, or provide both a desktop app and a command line tool. Treating each combination as one
category would make the shared rules grow with combinations rather than with the rules they hold.

Some parts recur in every project with the same shape: the core that holds the domain, the user
interface, the command line entry, and so on. When each project names these parts its own way, a
shared rule such as "the command line does not depend on UI code" cannot name them.

Capabilities differ from project to project. A shared name for a capability would fit some projects
and mislead others.

## Decision

Each project declares one language, an unordered set of framework layers, and paths for a fixed set
of shared roles in `stomme.toml`. Shared rules name roles and languages. Capability names stay with
the project.

### Roles

The shared roles are exactly `core`, `ui`, `kit`, `app`, and `cli`. A project maps each role it has
to one path in the `[roles]` table of `stomme.toml`. A project may have any subset, so the table
says whether it has an app, a command line tool, both, or neither.

- `core` holds the domain: its types, rules, and the I/O that every entry point shares. It depends on
  no other role.
- `ui` holds the project's views and UI state.
- `kit` holds reusable UI building blocks with no domain logic, such as wrapped components.
- `app` is the graphical entry point. It wires effects and owns the app's lifetime.
- `cli` is the command line entry point. It depends on `core` and on no UI role.

Code uses a role's name in the language's normal case. A project names the capability modules inside
a role itself, as [ADR 0002](./0002-capability-modules.md) says. The role list is closed, so a shared
rule can rely on it. Adding a role is a change to this ADR.

A role's folder is named after the role or ends with `-<role>`, such as `crates/tikk-cli` or
`src/core`. A `role-folder` problem is keyed by `<role>:<folder>`, so two roles that share the same
wrong folder stay separate recorded breaks.

### Languages

The language is `rust` or `typescript`. Each language has one coding guide, and a language rule
applies only to projects of that language.

### Layers

A framework layer adds rules for one framework. A project selects its layers as an unordered set.

- Layers only add or narrow rules. Each rule has one owner and one ID, so combining layers cannot
  create competing definitions of a rule.
- A layer belongs to one language. Selecting a layer of another language is an error.
- Conflicts count in both directions, even when only one layer declares the conflict.
- A layer that requires another layer does not add it. A missing required layer is an error, so the
  selection stays under the project's control.
- Layer order never changes meaning.
- A project that uses a framework without its layer fails `layer-declared`. Each layer names the
  signal that detects its use, and use through any other signal is not detected.

A wrong language, a conflicting pair, or an unknown layer is a broken installation, not an absent
one. Rejecting these choices keeps fallback behavior from hiding invalid shared rules.

## Consequences

### Positive

- Projects can combine frameworks without a new category for every combination.
- Shared rules can say which roles may depend on which, and every project reads them the same way.
- Roles describe the shape of a project without a second declaration of the same choice.

### Negative

- A project whose parts do not fit the five roles must map its paths onto the closest ones, or leave
  a part outside every role.
- Project owners must list required layers themselves.
- Layers cannot override shared rules to fit an incompatible choice.

## Alternatives considered

### One kind per project

Give each language, framework, and shape combination one kind. Rejected because it mixes independent
choices and needs a new kind for each new combination.

### Free role names per project

Let each project name its own roles. Rejected because shared rules could then not name the parts
they constrain, such as the rule that the command line uses no UI code.

### Shared capability names

Add shared names for common capabilities, such as a store or a sync module. Rejected because
capabilities differ across projects, and a shared name would fit some projects and mislead others.

### Ordered layers where the last one wins

Let later layers override earlier rules. Rejected because order would change meaning and could
silently weaken shared rules.
