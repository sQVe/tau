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
- [0034: Check house style outside the editor](./0034-check-house-style-outside-the-editor.md),
  partly superseded by 0035
- [0035: Use size thresholds as review guidance](./0035-use-size-thresholds-as-review-guidance.md)
- [0046: Declare types before values, except types derived with `typeof`](./0046-declare-types-before-values.md)
- [0052: Drop backwards compatibility by default](./0052-drop-backwards-compatibility-by-default.md)
- [0053: Version each saved record format](./0053-version-each-saved-record-format.md)
- [0055: Record Tau coding conventions in `AGENTS.md`](./0055-record-tau-coding-conventions-in-agents-md.md)
- [0109: Keep action behavior out of extension roots and name one concept one way](./0109-keep-action-behavior-out-of-extension-roots.md)
- [0120: Capability modules with an enforced import table](./0120-capability-modules-with-an-enforced-import-table.md)
- [0123: Patch Pi loaders to show no spinner](./0123-patch-pi-loaders-to-show-no-spinner.md)

## Documentation and writing

- [0006: Load Tau's instruction sets into every prompt](./0006-default-writing-policy.md)
- [0010: Documentation scope](./0010-documentation-scope.md)
- [0065: Put user decisions first in replies](./0065-put-user-decisions-first-in-replies.md), partly
  superseded by 0107
- [0107: State the problem and keep option order stable in questions](./0107-state-the-problem-and-keep-option-order-stable-in-questions.md)

## Prompts and instructions

- [0066: Add Tau's prompt text to Pi's append section](./0066-add-taus-prompt-text-to-pis-append-section.md)
- [0080: Store prompt snippets as files and insert them through autocomplete](./0080-insert-prompt-snippets-through-autocomplete.md)

## Skills and tools

- [0074: Let skills declare the actions they must own](./0074-let-skills-declare-the-actions-they-must-own.md)
- [0087: Use codemode to batch or filter evidence within an output budget](./0087-gather-evidence-with-codemode.md)
- [0088: Write skills in Markdown, with a guide, tools, and templates](./0088-grow-skills-into-tools-and-templates.md)
- [0093: Enable skill tools from session start](./0093-enable-skill-tools-from-session-start.md)

## Tests and checks

- [0005: Integration testing against a real Pi session](./0005-integration-testing-with-pi.md)
- [0012: Shared TDD state](./0012-shared-tdd-state.md), superseded by 0023
- [0023: Use advisory TDD observations instead of edit permissions](./0023-advisory-tdd-observations.md)
- [0039: Reuse reported checks and run one full suite per work state](./0039-reuse-reported-checks-and-run-one-full-suite.md)
- [0105: Queue full checks per repository and reuse passing logs](./0105-queue-full-checks-per-repository-and-reuse-passing-logs.md)
- [0106: Replay unchanged test projects in `pnpm check`](./0106-replay-unchanged-test-projects-in-pnpm-check.md)
- [0113: Mutation-test changed lines and list survivors as advice](./0113-run-diff-scoped-mutation-testing-by-hand.md)
- [0119: Share the mutation script as one npm package](./0119-share-the-mutation-script-as-one-npm-package.md)
- [0121: Test architecture rules for placement, naming, fakes, and fixtures](./0121-test-architecture-rules.md)
- [0123: Run the full check only at the PR step](./0123-run-the-full-check-only-at-the-pr-step.md)

## Commits

- [0024: Commit through Git hooks without human approval](./0024-commit-without-human-approval.md)

## Workers

- [0036: Allowlist worker content and label states from one table](./0036-allowlist-worker-content-and-label-states-from-one-table.md)
- [0043: Run subagents as Pi workers with a thin task layer over herdr](./0043-own-only-the-worker-guarantees-herdr-lacks.md)
- [0064: Deliver worker replies through records](./0064-deliver-worker-replies-through-records.md)
- [0067: Give each worker profile one loadout of tools, skills, instruction sets, and packages](./0067-give-workers-only-their-profile-tools-and-skills.md)
- [0076: Give browser workers one shared set of browser rules](./0076-give-browser-workers-one-shared-set-of-browser-rules.md)
- [0097: Track only the current session's workers](./0097-track-only-the-current-sessions-workers.md)
- [0102: Require acceptance criteria on editing worker launches](./0102-require-acceptance-criteria-on-editing-worker-launches.md)
- [0123: Delete stopped worker records 14 days after their last write](./0123-delete-stopped-worker-records-14-days-after-their-last-write.md)

## Manager sessions

- [0073: Leave manager compaction to Pi](./0073-leave-manager-compaction-to-pi.md)

## Configuration

- [0061: Keep Tau config in a user file and a trusted repository file](./0061-layer-tau-config-from-user-and-repository-files.md)

## Checkouts and worktrees

- [0048: Keep the bare repository root read-only for agents](./0048-keep-the-bare-repository-root-read-only-for-agents.md),
  superseded by 0051
- [0051: Note the bare root rule instead of enforcing it](./0051-note-the-bare-root-rule-instead-of-enforcing-it.md)
- [0090: Own each workstream with one worktree](./0090-own-each-workstream-with-one-worktree.md)

## Linear and slices

- [0075: Plan work as PR-sized slices in Linear](./0075-plan-work-as-pr-sized-slices-in-linear.md)
- [0082: Own Linear conventions in one tracker skill](./0082-own-linear-conventions-in-one-tracker-skill.md),
  partly superseded by 0108
- [0101: Treat `.tau/` files as the working copy and trackers as the saved copy](./0101-treat-tau-files-as-the-working-copy-and-trackers-as-the-saved-copy.md)
- [0108: Ask only before writes that other people see](./0108-make-linear-writes-on-the-users-own-work-without-asking.md)
- [0112: Review collaborative drafts as files in tuicr](./0112-review-collaborative-drafts-as-files-in-tuicr.md)

## Code review and pull requests

- [0060: Keep local code review in a skill](./0060-keep-local-code-review-in-a-skill.md), partly
  superseded by 0089
- [0089: Capture review targets with a code_review tool](./0089-capture-review-targets-with-a-code-review-tool.md),
  partly superseded by 0091
- [0091: Return review evidence from the code_review tool](./0091-return-review-evidence-from-the-code-review-tool.md)
- [0094: Compose PR publication evidence](./0094-compose-pr-publication-evidence.md)
- [0096: Create and keep linear stacks with gh stack](./0096-create-and-keep-linear-stacks-with-gh-stack.md)
- [0104: Capture fix reviews from a review snapshot](./0104-capture-fix-reviews-from-a-review-snapshot.md)
- [0111: Request review bots from config and skip the preview for a named change](./0111-request-review-bots-from-config-and-skip-named-changes-in-pr.md)
- [0122: Prune comments with a delete-only skill](./0122-prune-comments-with-a-delete-only-skill.md)

## Retired

| ADR  | Title                                                                          | Replaced by                                                                                                                                                                                                                       | Last commit |
| ---- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| 0001 | Application structure                                                          | [0120](./0120-capability-modules-with-an-enforced-import-table.md)                                                                                                                                                                | `a859a7bb`  |
| 0002 | File and directory naming conventions                                          | [0120](./0120-capability-modules-with-an-enforced-import-table.md)                                                                                                                                                                | `a859a7bb`  |
| 0004 | Skill authoring style                                                          | [0088](./0088-grow-skills-into-tools-and-templates.md), [0120](./0120-capability-modules-with-an-enforced-import-table.md)                                                                                                        | `b0980b75`  |
| 0008 | Coding instructions                                                            | [0006](./0006-default-writing-policy.md)                                                                                                                                                                                          | `b0980b75`  |
| 0009 | Prompt snippets                                                                | [0080](./0080-insert-prompt-snippets-through-autocomplete.md)                                                                                                                                                                     | `b0980b75`  |
| 0011 | Commit preapproval at startup                                                  | [0024](./0024-commit-without-human-approval.md)                                                                                                                                                                                   | `b0980b75`  |
| 0013 | Snippet placement                                                              | [0080](./0080-insert-prompt-snippets-through-autocomplete.md)                                                                                                                                                                     | `b0980b75`  |
| 0014 | Delegate model for bulk reads                                                  | [0087](./0087-gather-evidence-with-codemode.md)                                                                                                                                                                                   | `b0980b75`  |
| 0015 | Explicit repository commit commands                                            | [0024](./0024-commit-without-human-approval.md)                                                                                                                                                                                   | `b0980b75`  |
| 0016 | Prepare each commit with separate staging                                      | [0024](./0024-commit-without-human-approval.md)                                                                                                                                                                                   | `b0980b75`  |
| 0017 | Ask before adding generated files                                              | [0024](./0024-commit-without-human-approval.md)                                                                                                                                                                                   | `b0980b75`  |
| 0018 | Repository owners choose commit checks and hooks                               | [0024](./0024-commit-without-human-approval.md)                                                                                                                                                                                   | `b0980b75`  |
| 0019 | Verify backups before hiding working edits                                     | [0024](./0024-commit-without-human-approval.md)                                                                                                                                                                                   | `b0980b75`  |
| 0020 | Run staged checks in the existing checkout                                     | [0024](./0024-commit-without-human-approval.md)                                                                                                                                                                                   | `b0980b75`  |
| 0021 | Prune recovery snapshots after verified restoration                            | [0024](./0024-commit-without-human-approval.md)                                                                                                                                                                                   | `b0980b75`  |
| 0022 | Gate the clamped read hint on the remainder                                    | [0087](./0087-gather-evidence-with-codemode.md)                                                                                                                                                                                   | `b0980b75`  |
| 0025 | Use Git hooks without preparation                                              | [0024](./0024-commit-without-human-approval.md)                                                                                                                                                                                   | `b0980b75`  |
| 0026 | Let Git hooks own commit checks                                                | [0024](./0024-commit-without-human-approval.md)                                                                                                                                                                                   | `b0980b75`  |
| 0027 | Share one delegate model across bounded tool tasks                             | [0061](./0061-layer-tau-config-from-user-and-repository-files.md)                                                                                                                                                                 | `b0980b75`  |
| 0028 | Keep worker control in the parent                                              | [0043](./0043-own-only-the-worker-guarantees-herdr-lacks.md)                                                                                                                                                                      | `b0980b75`  |
| 0029 | Version worker provider fingerprints                                           | [0043](./0043-own-only-the-worker-guarantees-herdr-lacks.md)                                                                                                                                                                      | `b0980b75`  |
| 0030 | Claim native follow-ups before opening                                         | [0043](./0043-own-only-the-worker-guarantees-herdr-lacks.md)                                                                                                                                                                      | `b0980b75`  |
| 0031 | Reserve worker capacity under one tree lock                                    | [0043](./0043-own-only-the-worker-guarantees-herdr-lacks.md)                                                                                                                                                                      | `b0980b75`  |
| 0032 | Run Claude workers through a parent-owned channel                              | [0043](./0043-own-only-the-worker-guarantees-herdr-lacks.md)                                                                                                                                                                      | `b0980b75`  |
| 0033 | Use one generic native worker workflow                                         | [0043](./0043-own-only-the-worker-guarantees-herdr-lacks.md)                                                                                                                                                                      | `b0980b75`  |
| 0037 | Launch native workers without parent approval                                  | [0043](./0043-own-only-the-worker-guarantees-herdr-lacks.md)                                                                                                                                                                      | `b0980b75`  |
| 0038 | Block commits only on comment inaccuracies                                     | [0024](./0024-commit-without-human-approval.md)                                                                                                                                                                                   | `b0980b75`  |
| 0040 | Release undispatched follow-up claims after confirmed cleanup                  | [0043](./0043-own-only-the-worker-guarantees-herdr-lacks.md)                                                                                                                                                                      | `b0980b75`  |
| 0041 | Default the delegate to gpt-6-luna                                             | [0061](./0061-layer-tau-config-from-user-and-repository-files.md)                                                                                                                                                                 | `b0980b75`  |
| 0042 | Remove commit comment review                                                   | [0024](./0024-commit-without-human-approval.md)                                                                                                                                                                                   | `b0980b75`  |
| 0044 | Restore gpt-5.6-luna as the delegate default                                   | [0061](./0061-layer-tau-config-from-user-and-repository-files.md)                                                                                                                                                                 | `b0980b75`  |
| 0045 | Keep worker records per Tau checkout and worktree files in `.tau/`             | [0043](./0043-own-only-the-worker-guarantees-herdr-lacks.md), [0101](./0101-treat-tau-files-as-the-working-copy-and-trackers-as-the-saved-copy.md)                                                                                | `b0980b75`  |
| 0047 | Default bundled worker profiles to Opus 5.5                                    | [0061](./0061-layer-tau-config-from-user-and-repository-files.md)                                                                                                                                                                 | `b0980b75`  |
| 0049 | Treat the bash commit guard as guidance                                        | [0024](./0024-commit-without-human-approval.md)                                                                                                                                                                                   | `b0980b75`  |
| 0050 | Split worker control into a coordinator and one controller per worker          | [0043](./0043-own-only-the-worker-guarantees-herdr-lacks.md)                                                                                                                                                                      | `b0980b75`  |
| 0054 | Show one foreground worker per parent                                          | [0043](./0043-own-only-the-worker-guarantees-herdr-lacks.md)                                                                                                                                                                      | `b0980b75`  |
| 0056 | Load workflow rules apart from coding and writing                              | [0006](./0006-default-writing-policy.md)                                                                                                                                                                                          | `b0980b75`  |
| 0057 | Enforce pure decision modules from a registry                                  | [0120](./0120-capability-modules-with-an-enforced-import-table.md)                                                                                                                                                                | `a859a7bb`  |
| 0058 | Run subagents only as Pi workers                                               | [0043](./0043-own-only-the-worker-guarantees-herdr-lacks.md)                                                                                                                                                                      | `b0980b75`  |
| 0059 | Run each Pi worker as its pane's own process                                   | [0043](./0043-own-only-the-worker-guarantees-herdr-lacks.md)                                                                                                                                                                      | `b0980b75`  |
| 0062 | Put worker instructions in the system prompt                                   | [0066](./0066-add-taus-prompt-text-to-pis-append-section.md)                                                                                                                                                                      | `b0980b75`  |
| 0063 | Narrow allowed models from the user file to the repository file                | [0061](./0061-layer-tau-config-from-user-and-repository-files.md)                                                                                                                                                                 | `b0980b75`  |
| 0068 | Load only the instruction sets each worker profile needs                       | [0067](./0067-give-workers-only-their-profile-tools-and-skills.md)                                                                                                                                                                | `b0980b75`  |
| 0069 | Load each Pi package where its tools are used                                  | [0067](./0067-give-workers-only-their-profile-tools-and-skills.md)                                                                                                                                                                | `b0980b75`  |
| 0070 | Compact manager sessions at Pi turn boundaries                                 | [0073](./0073-leave-manager-compaction-to-pi.md)                                                                                                                                                                                  | `b0980b75`  |
| 0071 | Set worker models in the user config                                           | [0061](./0061-layer-tau-config-from-user-and-repository-files.md)                                                                                                                                                                 | `b0980b75`  |
| 0072 | Keep model defaults out of code                                                | [0061](./0061-layer-tau-config-from-user-and-repository-files.md)                                                                                                                                                                 | `b0980b75`  |
| 0077 | Keep a skill authoring guide in docs                                           | [0088](./0088-grow-skills-into-tools-and-templates.md), [0010](./0010-documentation-scope.md)                                                                                                                                     | `b0980b75`  |
| 0078 | Remind managers to compact and restore the worker ledger after each compaction | [0073](./0073-leave-manager-compaction-to-pi.md)                                                                                                                                                                                  | `b0980b75`  |
| 0079 | Grow modules from flat files                                                   | [0120](./0120-capability-modules-with-an-enforced-import-table.md)                                                                                                                                                                | `a859a7bb`  |
| 0081 | Sort prompt snippets by id                                                     | [0080](./0080-insert-prompt-snippets-through-autocomplete.md)                                                                                                                                                                     | `b0980b75`  |
| 0083 | Turn on skill tools when the skill runs, and confirm outside writes            | [0088](./0088-grow-skills-into-tools-and-templates.md), [0093](./0093-enable-skill-tools-from-session-start.md), [0108](./0108-make-linear-writes-on-the-users-own-work-without-asking.md), [0010](./0010-documentation-scope.md) | `b0980b75`  |
| 0084 | Keep the diagram skill out of worker profiles                                  | [0067](./0067-give-workers-only-their-profile-tools-and-skills.md)                                                                                                                                                                | `b0980b75`  |
| 0085 | Group per-repository settings in the user config                               | [0061](./0061-layer-tau-config-from-user-and-repository-files.md)                                                                                                                                                                 | `b0980b75`  |
| 0086 | Post to GitHub bots without a confirm                                          | [0108](./0108-make-linear-writes-on-the-users-own-work-without-asking.md)                                                                                                                                                         | `b0980b75`  |
| 0092 | Use codemode only to batch or filter evidence                                  | [0087](./0087-gather-evidence-with-codemode.md)                                                                                                                                                                                   | `b0980b75`  |
| 0095 | Keep repository routing in tracker config                                      | [0061](./0061-layer-tau-config-from-user-and-repository-files.md)                                                                                                                                                                 | `b0980b75`  |
| 0098 | Bound codemode output by whole items                                           | [0087](./0087-gather-evidence-with-codemode.md)                                                                                                                                                                                   | `b0980b75`  |
| 0099 | Warn on unknown config keys and fail only the entry in use                     | [0061](./0061-layer-tau-config-from-user-and-repository-files.md)                                                                                                                                                                 | `b0980b75`  |
| 0100 | Let agents cancel Linear tickets after approval                                | [0108](./0108-make-linear-writes-on-the-users-own-work-without-asking.md)                                                                                                                                                         | `b0980b75`  |
| 0103 | Write slice flow Linear changes without approval                               | [0108](./0108-make-linear-writes-on-the-users-own-work-without-asking.md)                                                                                                                                                         | `b0980b75`  |
| 0110 | Keep QA settings in a per-feature repository map                               | [0061](./0061-layer-tau-config-from-user-and-repository-files.md)                                                                                                                                                                 | `b0980b75`  |
| 0114 | Remind managers at half the context window to start a new session              | [0073](./0073-leave-manager-compaction-to-pi.md)                                                                                                                                                                                  | `b0980b75`  |
| 0115 | Copy the mutation script into each repository and fail on survivors            | [0113](./0113-run-diff-scoped-mutation-testing-by-hand.md), [0119](./0119-share-the-mutation-script-as-one-npm-package.md)                                                                                                        | `b0980b75`  |
| 0116 | Name the mutation command in the repository file                               | [0113](./0113-run-diff-scoped-mutation-testing-by-hand.md)                                                                                                                                                                        | `b0980b75`  |
| 0117 | List mutation survivors as advice instead of a gate                            | [0113](./0113-run-diff-scoped-mutation-testing-by-hand.md)                                                                                                                                                                        | `b0980b75`  |
| 0118 | List equivalent mutants instead of adding disable comments                     | [0113](./0113-run-diff-scoped-mutation-testing-by-hand.md)                                                                                                                                                                        | `b0980b75`  |
