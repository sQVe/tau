# Architecture decision records

ADRs record architectural choices and why we made them, not how we implemented a feature.

## Before writing

Follow the [writing instructions](../../src/extensions/writing/instructions.md) and
[ADR 0010](./0010-documentation-scope.md) for documentation scope. Before opening the
[template](./TEMPLATE.md), answer:

- What architectural choice are we making?
- What credible alternative did we consider, and why did we reject it?
- What lasting constraint or convention does this choice establish beyond the local implementation?

If the answers only describe local implementation, do not write an ADR. Code and tests can hold
those details. A feature change does not require a new document.

Use a title that names the choice. State it at the start of the Decision section, not buried in
implementation requirements. Include a detail only when changing it would change the decision or its
rationale. An ADR is not a feature summary, implementation plan, or acceptance checklist.

## Index

- [0001: Application structure](./0001-application-structure.md)
- [0002: File and directory naming conventions](./0002-file-naming-conventions.md)
- [0003: Stability of externally observable identifiers](./0003-externally-observable-identifiers.md)
- [0004: Skill authoring style](./0004-skill-authoring-style.md)
- [0005: Integration testing against a real Pi session](./0005-integration-testing-with-pi.md)
- [0006: Default writing policy](./0006-default-writing-policy.md)
- [0007: Vim keys in interactive components](./0007-vim-keys-in-interactive-components.md)
- [0008: Coding instructions](./0008-coding-instructions.md)
- [0009: Prompt snippets](./0009-prompt-snippets.md)
- [0010: Documentation scope](./0010-documentation-scope.md)
- [0011: Commit preapproval at startup](./0011-commit-preapproval.md)
- [0012: Shared TDD state](./0012-shared-tdd-state.md)
- [0013: Snippet placement](./0013-snippet-placement.md)
- [0014: Delegate model for bulk reads](./0014-delegate-model-for-bulk-reads.md)
