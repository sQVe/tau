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
- [0015: Explicit repository commit commands](./0015-explicit-repository-commit-commands.md)
- [0016: Prepare each commit with separate staging](./0016-staged-preparation-ownership.md)
- [0017: Ask before adding generated files](./0017-preparation-addition-assignment.md)
- [0018: Repository owners choose commit checks and hooks](./0018-staged-message-and-hook-policy.md)
- [0019: Verify backups before hiding working edits](./0019-verified-raw-recovery.md)
- [0020: Run staged checks in the existing checkout](./0020-checks-in-the-existing-checkout.md)
- [0021: Prune recovery snapshots after verified restoration](./0021-prune-verified-recovery.md)
- [0022: Gate the clamped read hint on the remainder](./0022-gate-the-clamped-read-hint-on-the-remainder.md)
- [0023: Use advisory TDD observations instead of edit permissions](./0023-advisory-tdd-observations.md)
- [0024: Commit without human approval](./0024-commit-without-human-approval.md)
- [0025: Use Git hooks without preparation](./0025-use-git-hooks-without-preparation.md)
- [0026: Let Git hooks own commit checks](./0026-let-git-hooks-own-commit-checks.md)
- [0027: Share one delegate model across bounded tool tasks](./0027-share-one-delegate-model.md)
- [0028: Keep worker control in the parent](./0028-keep-worker-control-in-the-parent.md)
- [0029: Version worker provider fingerprints](./0029-version-worker-provider-fingerprints.md)
- [0030: Claim native follow-ups before opening](./0030-claim-native-follow-ups-before-opening.md)
- [0031: Reserve worker capacity under one tree lock](./0031-reserve-worker-capacity-under-one-tree-lock.md)
- [0032: Run Claude workers through a parent-owned channel](./0032-run-claude-workers-through-a-parent-owned-channel.md)
- [0033: Use one generic native worker workflow](./0033-use-one-generic-native-worker-workflow.md)
- [0034: Check house style outside the editor](./0034-check-house-style-outside-the-editor.md)
- [0035: Use size thresholds as review guidance](./0035-use-size-thresholds-as-review-guidance.md)
- [0036: Allowlist worker content and label states from one table](./0036-allowlist-worker-content-and-label-states-from-one-table.md)
- [0037: Launch native workers without parent approval](./0037-launch-native-workers-without-parent-approval.md)
- [0038: Block commits only on comment inaccuracies](./0038-block-commits-only-on-comment-inaccuracies.md)
- [0039: Reuse reported checks and run one full suite per work state](./0039-reuse-reported-checks-and-run-one-full-suite.md)
