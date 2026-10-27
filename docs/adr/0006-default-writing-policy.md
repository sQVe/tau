# ADR 0006: Load Tau's instruction sets into every prompt

**Date**: 2026-09-07\
**Status**: Accepted\
**Supersedes**: [ADR 0008 (Coding instructions)](./README.md#retired),
[ADR 0056 (Load workflow rules apart from coding and writing)](./README.md#retired)\
**Related**: [ADR 0066 (Add Tau's prompt text to Pi's append section)](./0066-add-taus-prompt-text-to-pis-append-section.md),
[ADR 0067 (Give workers only their profile's tools and skills)](./0067-give-workers-only-their-profile-tools-and-skills.md),
[ADR 0076 (Give browser workers one shared set of browser rules)](./0076-give-browser-workers-one-shared-set-of-browser-rules.md)

## Context

Tau wants the same rules for prose, code, and ways of working in every ordinary agent run. Pi loads
a skill only when a task calls for it, so rules kept in a skill are missing from an ordinary reply.

Rules about different things drift into one file when only one file exists. Comment rules mixed how
a comment reads with whether it should exist. Workflow rules, such as staying out of other
worktrees, landed in the coding and writing files because nothing else loaded.

Lint cannot make most of these judgments. It can check layout, but not where a logical step begins
or whether a comment earns its place.

## Decision

Tau keeps its rules in instruction sets, one Markdown file per concern under `src/instructions/`,
and appends them to the system prompt before each ordinary agent run. One file per concern keeps a
code rule from being read as a prose rule, and loading by default means no skill has to be loaded
first.

### The sets

- `writing.md` governs text the agent writes: replies, commit and PR text, tickets, docs, and the
  wording of code comments.
- `coding.md` governs code the agent writes, including whether a comment should exist.
- `workflow.md` governs how the agent carries out a task: the commands it runs, the checkouts it
  touches, the scope it keeps, and when it stops.
- `browser.md` is opt-in for workers that drive a browser
  ([ADR 0076](./0076-give-browser-workers-one-shared-set-of-browser-rules.md)).

A rule goes in exactly one set. The task and repository rules come before the sets.

### Loading

- One extension, `src/extensions/instructions.ts`, loads the three default sets (`writing`,
  `coding`, and `workflow`) and appends each one through Pi's append section
  ([ADR 0066](./0066-add-taus-prompt-text-to-pis-append-section.md)). The text is added once per
  run, so it does not build up.
- A worker appends the sets its profile lists instead
  ([ADR 0067](./0067-give-workers-only-their-profile-tools-and-skills.md)).
- Reject a missing, unreadable, or blank default set when Tau loads. A visible load failure is
  better than a session that runs without its rules. A worker's selected sets, including `browser`,
  are read on its first `before_agent_start`, so a missing, unreadable, or blank one fails that
  hook.

### Not covered

Compaction and branch summaries use their own prompts and do not receive the sets. Other extensions
may replace the prompt.

## Consequences

### Positive

- Ordinary runs get the rules without loading a skill.
- Each concern has one file, and contributors can read the same file the agent reads.

### Negative

- Each loaded set costs prompt space on every run.
- Prompt rules cannot guarantee good writing or readable code.
- A broken or blank default set stops Tau from loading.
- A broken or blank worker set fails that worker's first `before_agent_start`.
- Rules near a boundary, such as comments, can drift between two sets.

## Alternatives considered

### One combined policy file

Put all rules in one file. Rejected because prose, code, and workflow rules then govern each other's
subjects, and agents read a code rule as a prose rule.

### Rules in a skill

Ship the rules as a skill, such as an unslop skill. Rejected because the model must load the skill
first, so ordinary replies miss the rules.

### Lint for code layout

Enforce code layout with lint only. Rejected because lint cannot see logical steps or judge whether
a comment is needed. Mechanical style is checked separately, outside the editor.

### Automatic rewriting

Rewrite responses after the model writes them. Rejected because it takes more time and risks
changing meaning.
