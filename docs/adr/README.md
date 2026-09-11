# Architecture decision records

Record lasting decisions and the reasons behind them, not how a feature works.

## Before writing

Follow the [writing instructions](../../src/extensions/writing/instructions.md) and
[ADR 0010](./0010-documentation-scope.md) for documentation scope. Before opening the
[template](./TEMPLATE.md), answer:

- What choice are we making, and what lasting reason stands behind it?
- What credible alternative did we consider, and why did we reject it?

If the answers only restate what the code does, do not write an ADR. Code and tests hold behavior. A
feature change does not require a new document.

Use a title that names the choice, and state that choice at the start of the Decision section. An
ADR is not a feature summary, implementation plan, or acceptance checklist.

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
