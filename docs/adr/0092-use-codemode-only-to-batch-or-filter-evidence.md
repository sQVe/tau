# ADR 0092: Use codemode only to batch or filter evidence

**Date**: 2026-10-06\
**Status**: Accepted\
**Supersedes**: the script scope and the tools a script may call in
[ADR 0087 (Gather evidence with codemode)](./0087-gather-evidence-with-codemode.md)

## Context

[ADR 0087](./0087-gather-evidence-with-codemode.md) made codemode Tau's way to gather evidence and
let a script call any tool except the control tools. The first measurement of worker sessions found
that codemode did not lower context use. One model sent most of its tool calls through scripts,
including file writes and edits, and its tool output per session did not drop. Many scripts made a
single call, few filtered their output, and many printed whole result objects, so panes showed
escaped JSON.

The instruction to gather evidence with codemode scripts caused this. Agents read it as "use
codemode for every call", including calls that change files.

## Decision

Agents call `read` and `bash` directly for a single lookup and use codemode only when one script
batches several calls or filters output before it returns. A script only gathers evidence, so Tau
refuses `write`, `edit`, `commit`, and `run_tests` calls that a script makes, in the manager and in
workers.

### Scripts return small, readable output

- A skill's script step still applies when the skill asks for one.
- A script prints strings, not result objects, and adds a result's status fields only when they are
  not the default.
- A script filters before it prints, returns line-numbered excerpts with their file, starts with a
  `max_output_tokens` limit of 4000, and names what it dropped as a gap.
- Agents cite only what a script or a direct tool call returned.

### Change tools stay out of scripts

- `write`, `edit`, `commit`, and `run_tests` reject a call that a script made, with a reason that
  says to call the tool directly. Direct calls work as before.
- The worker extension enforces the rule in workers, because a launched worker may run without Tau's
  other extensions. The workflow extension enforces it in the manager.
- `bash` stays callable from scripts, because it is the main way scripts read evidence.

## Consequences

### Positive

- Changes to files, commits, and test observations come only from direct calls that the model makes
  and the pane shows.
- Single lookups return their output directly, without a script wrapper or escaped JSON.

### Negative

- With Pi's codemode `only` mode, the direct tools are hidden and scripts cannot call the change
  tools, so an agent cannot change files. Tau does not support that mode.
- A script can still change state through `bash`. The guidelines forbid it, but nothing enforces it.

## Alternatives considered

### Reject scripts that make one tool call

Refuse a script with a single tool call. Rejected because one call that filters a large file before
it returns is the intended use.

### Change the guidelines without a block

Rely on the new wording alone. Rejected because the earlier wording already said scripts gather
evidence, and the measured sessions still sent file writes and edits through scripts.
