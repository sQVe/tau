# ADR 0098: Bound codemode output by whole items

**Date**: 2026-10-09\
**Status**: Accepted\
**Extends**: the output limit in
[ADR 0092 (Use codemode only to batch or filter evidence)](./0092-use-codemode-only-to-batch-or-filter-evidence.md)

## Context

ADR 0092 asked scripts to start with a 4,000-token output limit. Agents raised it in most scripts
without a stated need, so worker turns stayed large. Pi cuts an over-limit result by keeping the
first and last half of all text. Items in the middle of a batch vanish without a name, and the next
turn often reads the same range again.

Pi's `@options` line accepts only `max_output_tokens` and `timeout_ms`, and rejects any other field.

## Decision

Tau enforces a 4,000-token output budget on every codemode script and cuts an over-budget result by
whole `text()` items. A script that raises the budget must state its reason on the second line, as
`// @budget: <reason>`, or Tau refuses it before it runs. The reason goes on its own comment line
because Pi rejects unknown fields on the options line.

### Tau owns the cut

- Before a script runs, Tau raises Pi's own cap in the script it runs, so Pi never cuts the text.
  The saved transcript keeps the script the model wrote.
- After the script, Tau keeps whole items in order while they fit, with room for a gap item. The gap
  item names each cut item by number and first line, up to a fixed count, and names the rest as a
  range. Tau saves the full output to a private file and names its path.
- A result within the budget is returned as Pi made it.
- The workflow extension applies the budget in the manager, and the worker extension in workers.

## Consequences

### Positive

- An agent sees which items were cut and can read only those, from the saved file or again.
- Raising the budget becomes a deliberate choice with a reason in the transcript.

### Negative

- Tau depends on Pi's options-line format and its result layout of one header followed by the
  script's items. A change to either needs a change here.
- A script without an options line runs with one added, so error line numbers shift by one.
- One item larger than the budget is cut whole, even when its start would have fit.

## Alternatives considered

### Refuse an over-budget script

Return an error instead of a trimmed result. Rejected because the script has already run by then,
and its output that fits is still useful evidence.

### Keep Pi's cut

Leave the cut to Pi and enforce only the reason for a raise. Rejected because Pi's cut drops items
from the middle without a name, which causes the repeated reads.
