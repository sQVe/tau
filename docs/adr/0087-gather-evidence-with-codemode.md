# ADR 0087: Use codemode to batch or filter evidence within an output budget

**Date**: 2026-10-05\
**Status**: Accepted\
**Supersedes**: [ADR 0014 (Delegate model for bulk reads)](./README.md#retired),
[ADR 0022 (Gate the clamped read hint on the remainder)](./README.md#retired), the `bulk_read`
section in [ADR 0072 (Keep model defaults out of code)](./README.md#retired), the `bulkRead` key
handling in [ADR 0085 (Group per-repository settings in the user config)](./README.md#retired),
[ADR 0092 (Use codemode only to batch or filter evidence)](./README.md#retired), and
[ADR 0098 (Bound codemode output by whole items)](./README.md#retired)\
**Related**: [ADR 0067 (Give each worker profile one loadout of tools, skills, instruction sets, and packages)](./0067-give-workers-only-their-profile-tools-and-skills.md)
for profile tool allowlists,
[ADR 0061 (Keep Tau config in a user file and a trusted repository file)](./0061-layer-tau-config-from-user-and-repository-files.md)
for config placement and validation

## Context

`bulk_read` sent file reading to a cheaper model and trimmed long reads. Agents then cited the
delegate's summary instead of the source.

Codemode runs one script that calls the session's tools and returns only what the script keeps. One
script can gather the same evidence without a second model and without raw output in context.

Agents read the codemode guidance as "use codemode for every call". They sent file writes and edits
through scripts, wrote scripts that made a single call, and printed whole result objects, so panes
showed escaped JSON. Agents also raised the output limit without a stated need.

A script can call any tool the session allows. Without a limit, a script could send a worker report,
ask the user a question, or launch a worker. Tau's rules for these calls assume the model makes them
directly.

## Decision

Codemode is Tau's way to gather evidence, for the manager and for the profiles that read the
repository. The qa and browser workers do not get codemode. `bulk_read` is removed, with no alias
and no summary replacement.

The rule has three parts: what a script is for, which tools it may call, and how much output it may
return.

### Scripts batch or filter evidence

- Agents call `read` and `bash` directly for a single lookup. They use codemode only when one script
  batches several calls or filters output before it returns.
- A skill's script step applies when the skill asks for one. Target resolution, approvals, writes,
  and review judgment stay outside the script.
- A script plans one evidence set. It discovers paths first, batches independent bounded reads so
  one failure does not hide the others, and names failed reads and omitted evidence as gaps.
- A script returns filtered, located excerpts, not whole result objects.
- A script never treats capped text as complete data. It queries data files with a bounded command.
- The codemode guidelines state the exact calls and commands that follow these rules.
- Agents cite only what a script or a direct tool call returned. A fact that the script filtered out
  must be gathered again before an agent cites it.

### Scripts call only evidence tools

- `write`, `edit`, `commit`, and `run_tests` cannot be called from a script. Tau refuses such a call
  with a reason that says to call the tool directly. This applies in the manager and in workers.
- Report, question, progress, user question, and orchestration tools are model-only. Tau refuses a
  call to them from a script, in the manager and in workers.
- Read-only status tools, such as `subagent_status`, stay callable from a script.
- `bash` stays callable, because it is the main way scripts read evidence. Tau does not sandbox
  `bash`, so a script can still change state through it. The guidelines forbid that, but nothing
  enforces it.
- A hook that cuts the model-facing text of a tool result keeps its structured result unchanged, so
  a script reads what the tool returned. The worker's `bash` output cap follows this rule. That
  result may itself be truncated by the tool and name a saved output file.

### Output is bounded by whole items

- A script has an output budget of 4,000 tokens. Tau enforces it on every codemode script in the
  manager and in workers.
- A script that raises the budget sets `max_output_tokens` on the first line. It states the reason
  on the second line as `// @budget: <reason>`. Tau refuses a raise without a reason before the
  script runs.
- Tau raises Pi's own cap before a script runs, so Pi never cuts the text. The saved transcript
  keeps the script the model wrote.
- Over the budget, Tau keeps whole `text()` items in order while they fit. A gap item names each cut
  item by number and first line, up to a fixed count, and names the rest as a range.
- A budget smaller than the room the gap item needs counts as that room, so the list of cut items
  never outgrows the output it replaces.
- Tau saves the full output to a private file and names its path. When the save fails, Tau says so.
- A result within the budget is returned as Pi made it.
- Tau finds item boundaries in Pi's joined text by its numbered `==> text N/M <==` headers. Pi joins
  a script's text items into one text and has no public API for separate items. Keep this approach
  until Pi ships one.

## Consequences

### Positive

- Agents cite source lines instead of a delegate's summary.
- One script replaces a chain of reads and searches, and raw output stays out of context.
- One model fewer to configure.
- Control and change calls keep their rules, because only the model makes them directly.
- An agent sees which items were cut and reads only those, from the saved file or again.
- Raising the budget becomes a deliberate choice with a reason in the transcript.

### Negative

- The session model pays for the evidence it reads, where `bulk_read` passed bulk reading to a
  cheaper model.
- A script that filters too much hides facts. The citation rule makes the agent gather them again,
  which costs another script.
- The qa and browser workers keep gathering evidence one tool call at a time.
- Nothing enforces the rule against changing state through `bash`.
- With Pi's codemode `only` mode, the direct tools are hidden and scripts cannot call the change
  tools, so an agent cannot change files. Tau does not support that mode.
- Tau depends on Pi's options-line format and on its result layout of one header followed by the
  script's items. A change to either needs a change here.
- A script without an options line runs with one added, so error line numbers shift by one.
- One item larger than the budget is cut whole, even when its start would have fit.

## Alternatives considered

### Keep `bulk_read` next to codemode

Keep `bulk_read` next to codemode. Rejected because two ways to gather evidence split the
instructions, and the delegate summaries remain uncited secondhand claims.

### Codemode script with a cheaper model summary

Replace `bulk_read` with a codemode script that asks a cheaper model for a summary. Rejected because
it keeps the same uncited summaries.

### Codemode for every worker profile

Give codemode to every worker profile. Rejected because qa and browser workers act in a browser and
do not gather repository evidence in bulk.

### Reject scripts that make one tool call

Refuse a script with a single tool call. Rejected because one call that filters a large file before
it returns is the intended use.

### Change the guidelines without a block

Rely on the guideline wording alone. Rejected because the earlier wording already said scripts
gather evidence, and agents still sent file writes and edits through scripts.

### Refuse an over-budget script

Return an error instead of a trimmed result. Rejected because the script has already run by then,
and its output that fits is still useful evidence.

### Keep Pi's cut

Leave the cut to Pi and enforce only the reason for a raise. Rejected because Pi's cut drops items
from the middle without a name, which causes repeated reads.
