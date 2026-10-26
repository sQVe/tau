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

## Keeping ADRs current

A new ADR is Accepted, and Accepted is the only status. Merging its PR is the approval, so there is
no Proposed stage. When details of a decision change, edit its ADR in place. Supersede an ADR only
when its core choice reverses: the new ADR states the whole current rule and names the old one on
its Supersedes line. Delete the old file and add it to the Retired table. Numbers are never reused.
`git show <commit>:docs/adr/<file>` prints a retired ADR from its last commit.

Older ADRs still have a Superseded status or name the parts that later ADRs supersede. Until those
chains merge, the index line of each such ADR ends with "superseded by" or "partly superseded by"
and the numbers that its status names.

## Project and code

- [0003: Stability of externally observable identifiers](./0003-externally-observable-identifiers.md)
- [0007: Vim keys in interactive components](./0007-vim-keys-in-interactive-components.md)
- [0008: Coding instructions](./0008-coding-instructions.md), partly superseded by 0042
- [0034: Check house style outside the editor](./0034-check-house-style-outside-the-editor.md),
  partly superseded by 0035
- [0035: Use size thresholds as review guidance](./0035-use-size-thresholds-as-review-guidance.md)
- [0046: Declare types before values, except types derived with `typeof`](./0046-declare-types-before-values.md)
- [0052: Drop backwards compatibility by default](./0052-drop-backwards-compatibility-by-default.md)
- [0053: Version each saved record format](./0053-version-each-saved-record-format.md)
- [0055: Record Tau coding conventions in `AGENTS.md`](./0055-record-tau-coding-conventions-in-agents-md.md)
- [0109: Keep action behavior out of extension roots and name one concept one way](./0109-keep-action-behavior-out-of-extension-roots.md)
- [0120: Capability modules with an enforced import table](./0120-capability-modules-with-an-enforced-import-table.md)

## Documentation and writing

- [0006: Default writing policy](./0006-default-writing-policy.md)
- [0010: Documentation scope](./0010-documentation-scope.md)
- [0065: Put user decisions first in replies](./0065-put-user-decisions-first-in-replies.md), partly
  superseded by 0107
- [0107: State the problem and keep option order stable in questions](./0107-state-the-problem-and-keep-option-order-stable-in-questions.md)

## Prompts and instructions

- [0009: Prompt snippets](./0009-prompt-snippets.md), partly superseded by 0080 and 0081
- [0013: Snippet placement](./0013-snippet-placement.md), superseded by 0080
- [0056: Load workflow rules apart from coding and writing](./0056-load-workflow-rules-apart-from-coding-and-writing.md)
- [0066: Add Tau's prompt text to Pi's append section](./0066-add-taus-prompt-text-to-pis-append-section.md)
- [0080: Insert prompt snippets through autocomplete](./0080-insert-prompt-snippets-through-autocomplete.md)
- [0081: Sort prompt snippets by id](./0081-sort-prompt-snippets-by-id.md)

## Skills and tools

- [0004: Skill authoring style](./0004-skill-authoring-style.md), partly superseded by 0120 and 0088
- [0022: Gate the clamped read hint on the remainder](./0022-gate-the-clamped-read-hint-on-the-remainder.md),
  superseded by 0087
- [0074: Let skills declare the actions they must own](./0074-let-skills-declare-the-actions-they-must-own.md)
- [0077: Keep a skill authoring guide in docs](./0077-keep-a-skill-authoring-guide-in-docs.md)
- [0083: Turn on skill tools when the skill runs, and confirm outside writes](./0083-turn-on-skill-tools-when-the-skill-runs-and-confirm-outside-writes.md),
  partly superseded by 0093 and 0103
- [0087: Gather evidence with codemode](./0087-gather-evidence-with-codemode.md), partly superseded
  by 0092 and 0097
- [0088: Grow skills into tools and templates](./0088-grow-skills-into-tools-and-templates.md)
- [0092: Use codemode only to batch or filter evidence](./0092-use-codemode-only-to-batch-or-filter-evidence.md)
- [0093: Enable skill tools from session start](./0093-enable-skill-tools-from-session-start.md)
- [0098: Bound codemode output by whole items](./0098-bound-codemode-output-by-whole-items.md)

## Tests and checks

- [0005: Integration testing against a real Pi session](./0005-integration-testing-with-pi.md)
- [0012: Shared TDD state](./0012-shared-tdd-state.md), superseded by 0023
- [0023: Use advisory TDD observations instead of edit permissions](./0023-advisory-tdd-observations.md)
- [0039: Reuse reported checks and run one full suite per work state](./0039-reuse-reported-checks-and-run-one-full-suite.md)
- [0105: Queue full checks per repository and reuse passing logs](./0105-queue-full-checks-per-repository-and-reuse-passing-logs.md)
- [0106: Replay unchanged test projects in `pnpm check`](./0106-replay-unchanged-test-projects-in-pnpm-check.md)
- [0113: Run diff-scoped mutation testing by hand](./0113-run-diff-scoped-mutation-testing-by-hand.md),
  partly superseded by 0115
- [0115: Copy the mutation script into each repository and fail on survivors](./0115-copy-mutation-script-per-repository-and-fail-on-survivors.md),
  partly superseded by 0117, 0118, and 0119
- [0116: Name the mutation command in the repository file](./0116-name-the-mutation-command-in-the-repository-file.md)
- [0117: List mutation survivors as advice instead of a gate](./0117-list-mutation-survivors-as-advice.md)
- [0118: List equivalent mutants instead of adding disable comments](./0118-list-equivalent-mutants-instead-of-disable-comments.md)
- [0119: Share the mutation script as one npm package](./0119-share-the-mutation-script-as-one-npm-package.md)
- [0121: Test architecture rules for placement, naming, fakes, and fixtures](./0121-test-architecture-rules.md)

## Commits

- [0011: Commit preapproval at startup](./0011-commit-preapproval.md), superseded by 0024
- [0015: Explicit repository commit commands](./0015-explicit-repository-commit-commands.md),
  superseded by 0026
- [0016: Prepare each commit with separate staging](./0016-staged-preparation-ownership.md),
  superseded by 0025
- [0017: Ask before adding generated files](./0017-preparation-addition-assignment.md), superseded
  by 0024
- [0018: Repository owners choose commit checks and hooks](./0018-staged-message-and-hook-policy.md),
  superseded by 0026
- [0019: Verify backups before hiding working edits](./0019-verified-raw-recovery.md), superseded by
  0025
- [0020: Run staged checks in the existing checkout](./0020-checks-in-the-existing-checkout.md),
  superseded by 0026
- [0021: Prune recovery snapshots after verified restoration](./0021-prune-verified-recovery.md),
  superseded by 0025
- [0024: Commit without human approval](./0024-commit-without-human-approval.md), partly superseded
  by 0025 and 0042
- [0025: Use Git hooks without preparation](./0025-use-git-hooks-without-preparation.md), partly
  superseded by 0026 and 0042
- [0026: Let Git hooks own commit checks](./0026-let-git-hooks-own-commit-checks.md), partly
  superseded by 0038 and 0042
- [0038: Block commits only on comment inaccuracies](./0038-block-commits-only-on-comment-inaccuracies.md),
  superseded by 0042
- [0042: Remove commit comment review](./0042-remove-commit-comment-review.md)
- [0049: Treat the bash commit guard as guidance](./0049-treat-the-bash-commit-guard-as-guidance.md)

## Models

- [0014: Delegate model for bulk reads](./0014-delegate-model-for-bulk-reads.md), superseded by 0087
  and 0027
- [0027: Share one delegate model across bounded tool tasks](./0027-share-one-delegate-model.md),
  superseded by 0072, 0044, and 0042
- [0041: Default the delegate to gpt-6-luna](./0041-default-the-delegate-to-gpt-6-luna.md),
  superseded by 0044 and 0042
- [0044: Restore gpt-5.6-luna as the delegate default](./0044-restore-gpt-5-6-luna-as-the-delegate-default.md),
  superseded by 0072
- [0047: Default bundled worker profiles to Opus 5.5](./0047-default-bundled-worker-profiles-to-opus-5-5.md),
  superseded by 0071
- [0063: Narrow allowed models from the user file to the repository file](./0063-narrow-allowed-models-from-user-to-repository.md)
- [0071: Set worker models in the user config](./0071-set-worker-models-in-the-user-config.md),
  partly superseded by 0072 and 0099
- [0072: Keep model defaults out of code](./0072-keep-model-defaults-out-of-code.md), partly
  superseded by 0087

## Workers

- [0028: Keep worker control in the parent](./0028-keep-worker-control-in-the-parent.md), partly
  superseded by 0043 and 0059
- [0029: Version worker provider fingerprints](./0029-version-worker-provider-fingerprints.md),
  superseded by 0043
- [0030: Claim native follow-ups before opening](./0030-claim-native-follow-ups-before-opening.md),
  superseded by 0043
- [0031: Reserve worker capacity under one tree lock](./0031-reserve-worker-capacity-under-one-tree-lock.md),
  superseded by 0043
- [0032: Run Claude workers through a parent-owned channel](./0032-run-claude-workers-through-a-parent-owned-channel.md),
  superseded by 0033 and 0058
- [0033: Use one generic native worker workflow](./0033-use-one-generic-native-worker-workflow.md),
  superseded by 0058, 0037, 0045, and 0043
- [0036: Allowlist worker content and label states from one table](./0036-allowlist-worker-content-and-label-states-from-one-table.md)
- [0037: Launch native workers without parent approval](./0037-launch-native-workers-without-parent-approval.md),
  superseded by 0058 and 0045
- [0040: Release undispatched follow-up claims after confirmed cleanup](./0040-release-undispatched-follow-up-claims-after-cleanup.md),
  superseded by 0043
- [0043: Own only the worker guarantees herdr lacks](./0043-own-only-the-worker-guarantees-herdr-lacks.md),
  partly superseded by 0054, 0058, and 0059
- [0045: Keep worker records per Tau checkout and worktree files in `.tau/`](./0045-keep-worker-records-per-checkout-and-worktree-files-in-tau.md),
  partly superseded by 0058 and 0097
- [0050: Split worker control into a coordinator and one controller per worker](./0050-split-worker-control-into-a-coordinator-and-one-controller-per-worker.md),
  partly superseded by 0058
- [0054: Show one foreground worker per parent](./0054-show-one-foreground-worker-per-parent.md)
- [0058: Run subagents only as Pi workers](./0058-run-subagents-only-as-pi-workers.md), partly
  superseded by 0097
- [0059: Run each Pi worker as its pane's own process](./0059-run-each-pi-worker-as-its-panes-own-process.md)
- [0062: Put worker instructions in the system prompt](./0062-put-worker-instructions-in-the-system-prompt.md),
  superseded by 0066
- [0064: Deliver worker replies through records](./0064-deliver-worker-replies-through-records.md)
- [0067: Give workers only their profile's tools and skills](./0067-give-workers-only-their-profile-tools-and-skills.md),
  partly superseded by 0087
- [0068: Load only the instruction sets each worker profile needs](./0068-load-only-the-instruction-sets-each-worker-profile-needs.md),
  partly superseded by 0076
- [0069: Load each Pi package where its tools are used](./0069-load-each-pi-package-where-its-tools-are-used.md)
- [0076: Give browser workers one shared set of browser rules](./0076-give-browser-workers-one-shared-set-of-browser-rules.md)
- [0084: Keep the diagram skill out of worker profiles](./0084-keep-the-diagram-skill-out-of-worker-profiles.md)
- [0097: Track only the current session's workers](./0097-track-only-the-current-sessions-workers.md)
- [0102: Require acceptance criteria on editing worker launches](./0102-require-acceptance-criteria-on-editing-worker-launches.md)
- [0123: Delete stopped worker records 14 days after their last write](./0123-delete-stopped-worker-records-14-days-after-their-last-write.md)

## Manager sessions

- [0070: Compact manager sessions at Pi turn boundaries](./0070-compact-manager-sessions-at-pi-turn-boundaries.md),
  superseded by 0073
- [0073: Leave manager compaction to Pi](./0073-leave-manager-compaction-to-pi.md), partly
  superseded by 0097
- [0078: Remind managers to compact and restore the worker ledger after each compaction](./0078-remind-managers-to-compact-and-restore-the-worker-ledger.md),
  partly superseded by 0097 and 0114
- [0114: Remind managers at half the context window to start a new session](./0114-remind-managers-at-half-the-context-window-to-start-a-new-session.md)

## Configuration

- [0061: Layer Tau config from user and repository files](./0061-layer-tau-config-from-user-and-repository-files.md),
  partly superseded by 0099
- [0085: Group per-repository settings in the user config](./0085-group-per-repository-settings-in-the-user-config.md),
  superseded by 0095 and 0087
- [0095: Keep repository routing in tracker config](./0095-keep-repository-routing-in-tracker-config.md),
  partly superseded by 0099
- [0099: Warn on unknown config keys and fail only the entry in use](./0099-warn-on-unknown-config-keys-and-fail-only-the-entry-in-use.md)
- [0110: Keep QA settings in a per-feature repository map](./0110-keep-qa-settings-in-a-per-feature-repository-map.md)

## Checkouts and worktrees

- [0048: Keep the bare repository root read-only for agents](./0048-keep-the-bare-repository-root-read-only-for-agents.md),
  superseded by 0051
- [0051: Note the bare root rule instead of enforcing it](./0051-note-the-bare-root-rule-instead-of-enforcing-it.md)
- [0090: Own each workstream with one worktree](./0090-own-each-workstream-with-one-worktree.md)

## Linear and slices

- [0075: Plan work as PR-sized slices in Linear](./0075-plan-work-as-pr-sized-slices-in-linear.md),
  partly superseded by 0103
- [0082: Own Linear conventions in one tracker skill](./0082-own-linear-conventions-in-one-tracker-skill.md),
  partly superseded by 0100
- [0100: Let agents cancel Linear tickets after approval](./0100-let-agents-cancel-linear-tickets-after-approval.md)
- [0101: Treat `.tau/` files as the working copy and trackers as the saved copy](./0101-treat-tau-files-as-the-working-copy-and-trackers-as-the-saved-copy.md),
  partly superseded by 0103
- [0103: Write slice flow Linear changes without approval](./0103-write-slice-flow-linear-changes-without-approval.md),
  superseded by 0108
- [0108: Make Linear writes on the user's own work without asking](./0108-make-linear-writes-on-the-users-own-work-without-asking.md)
- [0112: Review collaborative drafts as files in tuicr](./0112-review-collaborative-drafts-as-files-in-tuicr.md)

## Code review and pull requests

- [0060: Keep local code review in a skill](./0060-keep-local-code-review-in-a-skill.md), partly
  superseded by 0089
- [0086: Post to GitHub bots without a confirm](./0086-post-to-github-bots-without-a-confirm.md)
- [0089: Capture review targets with a code_review tool](./0089-capture-review-targets-with-a-code-review-tool.md),
  partly superseded by 0091
- [0091: Return review evidence from the code_review tool](./0091-return-review-evidence-from-the-code-review-tool.md)
- [0094: Compose PR publication evidence](./0094-compose-pr-publication-evidence.md)
- [0096: Create and keep linear stacks with gh stack](./0096-create-and-keep-linear-stacks-with-gh-stack.md)
- [0104: Capture fix reviews from a review snapshot](./0104-capture-fix-reviews-from-a-review-snapshot.md)
- [0111: Request review bots from config and skip the preview for a named change](./0111-request-review-bots-from-config-and-skip-named-changes-in-pr.md)
- [0122: Prune comments with a delete-only skill](./0122-prune-comments-with-a-delete-only-skill.md)

## Retired

| ADR  | Title                                         | Replaced by                                                        | Last commit |
| ---- | --------------------------------------------- | ------------------------------------------------------------------ | ----------- |
| 0001 | Application structure                         | [0120](./0120-capability-modules-with-an-enforced-import-table.md) | `a859a7bb`  |
| 0002 | File and directory naming conventions         | [0120](./0120-capability-modules-with-an-enforced-import-table.md) | `a859a7bb`  |
| 0057 | Enforce pure decision modules from a registry | [0120](./0120-capability-modules-with-an-enforced-import-table.md) | `a859a7bb`  |
| 0079 | Grow modules from flat files                  | [0120](./0120-capability-modules-with-an-enforced-import-table.md) | `a859a7bb`  |
