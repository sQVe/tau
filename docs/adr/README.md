# Architecture decision records

Record lasting decisions and the reasons behind them, not how a feature works.

## Before writing

Follow the [writing instructions](../../src/instructions/writing.md) and
[ADR 0010](./0010-documentation-scope.md) for documentation scope. Before opening the
[template](./TEMPLATE.md), answer:

- What choice are we making, and what lasting reason stands behind it?
- What credible alternative did we consider, and why did we reject it?

If the answers only restate what the code does, do not write an ADR. Code and tests hold behavior. A
feature change does not require a new document.

Use a title that names the choice, and state that choice in the first sentence of the Decision
section. Give each rejected or deferred alternative its own heading under Alternatives considered.
An ADR is not a feature summary, implementation plan, or acceptance checklist.

A new ADR is Accepted. Merging its PR is the approval, so there is no Proposed stage. When a later
decision replaces it, keep its reasoning, change its status to Superseded, and add a Superseded by
line that links to the replacement.

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
- [0040: Release undispatched follow-up claims after confirmed cleanup](./0040-release-undispatched-follow-up-claims-after-cleanup.md)
- [0041: Default the delegate to gpt-6-luna](./0041-default-the-delegate-to-gpt-6-luna.md)
- [0042: Remove commit comment review](./0042-remove-commit-comment-review.md)
- [0043: Own only the worker guarantees herdr lacks](./0043-own-only-the-worker-guarantees-herdr-lacks.md)
- [0044: Restore gpt-5.6-luna as the delegate default](./0044-restore-gpt-5-6-luna-as-the-delegate-default.md)
- [0045: Keep worker records per Tau checkout and worktree files in `.tau/`](./0045-keep-worker-records-per-checkout-and-worktree-files-in-tau.md)
- [0046: Declare types before values, except types derived with `typeof`](./0046-declare-types-before-values.md)
- [0047: Default bundled worker profiles to Opus 5.5](./0047-default-bundled-worker-profiles-to-opus-5-5.md)
- [0048: Keep the bare repository root read-only for agents](./0048-keep-the-bare-repository-root-read-only-for-agents.md)
- [0049: Treat the bash commit guard as guidance](./0049-treat-the-bash-commit-guard-as-guidance.md)
- [0050: Split worker control into a coordinator and one controller per worker](./0050-split-worker-control-into-a-coordinator-and-one-controller-per-worker.md)
- [0051: Note the bare root rule instead of enforcing it](./0051-note-the-bare-root-rule-instead-of-enforcing-it.md)
- [0052: Drop backwards compatibility by default](./0052-drop-backwards-compatibility-by-default.md)
- [0053: Version each saved record format](./0053-version-each-saved-record-format.md)
- [0054: Show one foreground worker per parent](./0054-show-one-foreground-worker-per-parent.md)
- [0055: Record Tau coding conventions in `AGENTS.md`](./0055-record-tau-coding-conventions-in-agents-md.md)
- [0056: Load workflow rules apart from coding and writing](./0056-load-workflow-rules-apart-from-coding-and-writing.md)
- [0057: Enforce pure decision modules from a registry](./0057-enforce-pure-decision-modules-from-a-registry.md)
- [0058: Run subagents only as Pi workers](./0058-run-subagents-only-as-pi-workers.md)
- [0059: Run each Pi worker as its pane's own process](./0059-run-each-pi-worker-as-its-panes-own-process.md)
- [0060: Keep local code review in a skill](./0060-keep-local-code-review-in-a-skill.md)
- [0061: Layer Tau config from user and repository files](./0061-layer-tau-config-from-user-and-repository-files.md)
- [0062: Put worker instructions in the system prompt](./0062-put-worker-instructions-in-the-system-prompt.md)
- [0063: Narrow allowed models from the user file to the repository file](./0063-narrow-allowed-models-from-user-to-repository.md)
- [0064: Deliver worker replies through records](./0064-deliver-worker-replies-through-records.md)
- [0065: Put user decisions first in replies](./0065-put-user-decisions-first-in-replies.md)
- [0066: Add Tau's prompt text to Pi's append section](./0066-add-taus-prompt-text-to-pis-append-section.md)
- [0067: Give workers only their profile's tools and skills](./0067-give-workers-only-their-profile-tools-and-skills.md)
- [0068: Load only the instruction sets each worker profile needs](./0068-load-only-the-instruction-sets-each-worker-profile-needs.md)
- [0069: Load each Pi package where its tools are used](./0069-load-each-pi-package-where-its-tools-are-used.md)
- [0070: Compact manager sessions at Pi turn boundaries](./0070-compact-manager-sessions-at-pi-turn-boundaries.md)
- [0071: Set worker models in the user config](./0071-set-worker-models-in-the-user-config.md)
- [0072: Keep model defaults out of code](./0072-keep-model-defaults-out-of-code.md)
- [0073: Leave manager compaction to Pi](./0073-leave-manager-compaction-to-pi.md)
- [0074: Let skills declare the actions they must own](./0074-let-skills-declare-the-actions-they-must-own.md)
- [0075: Plan work as PR-sized slices in Linear](./0075-plan-work-as-pr-sized-slices-in-linear.md)
- [0076: Give browser workers one shared set of browser rules](./0076-give-browser-workers-one-shared-set-of-browser-rules.md)
- [0077: Keep a skill authoring guide in docs](./0077-keep-a-skill-authoring-guide-in-docs.md)
- [0078: Remind managers to compact and restore the worker ledger after each compaction](./0078-remind-managers-to-compact-and-restore-the-worker-ledger.md)
- [0079: Grow modules from flat files](./0079-grow-modules-from-flat-files.md)
- [0080: Insert prompt snippets through autocomplete](./0080-insert-prompt-snippets-through-autocomplete.md)
- [0081: Sort prompt snippets by id](./0081-sort-prompt-snippets-by-id.md)
- [0082: Own Linear conventions in one tracker skill](./0082-own-linear-conventions-in-one-tracker-skill.md)
- [0083: Turn on skill tools when the skill runs, and confirm outside writes](./0083-turn-on-skill-tools-when-the-skill-runs-and-confirm-outside-writes.md)
- [0084: Keep the diagram skill out of worker profiles](./0084-keep-the-diagram-skill-out-of-worker-profiles.md)
- [0085: Group per-repository settings in the user config](./0085-group-per-repository-settings-in-the-user-config.md)
  (Superseded by 0087 and 0095)
- [0086: Post to GitHub bots without a confirm](./0086-post-to-github-bots-without-a-confirm.md)
- [0087: Gather evidence with codemode](./0087-gather-evidence-with-codemode.md)
- [0088: Grow skills into tools and templates](./0088-grow-skills-into-tools-and-templates.md)
- [0089: Capture review targets with a code_review tool](./0089-capture-review-targets-with-a-code-review-tool.md)
- [0090: Own each workstream with one worktree](./0090-own-each-workstream-with-one-worktree.md)
- [0091: Return review evidence from the code_review tool](./0091-return-review-evidence-from-the-code-review-tool.md)
- [0092: Use codemode only to batch or filter evidence](./0092-use-codemode-only-to-batch-or-filter-evidence.md)
- [0093: Enable skill tools from session start](./0093-enable-skill-tools-from-session-start.md)
- [0094: Compose PR publication evidence](./0094-compose-pr-publication-evidence.md)
- [0095: Keep repository routing in tracker config](./0095-keep-repository-routing-in-tracker-config.md)
- [0096: Create and keep linear stacks with gh stack](./0096-create-and-keep-linear-stacks-with-gh-stack.md)
- [0097: Track only the current session's workers](./0097-track-only-the-current-sessions-workers.md)
- [0098: Bound codemode output by whole items](./0098-bound-codemode-output-by-whole-items.md)
- [0099: Warn on unknown config keys and fail only the entry in use](./0099-warn-on-unknown-config-keys-and-fail-only-the-entry-in-use.md)
