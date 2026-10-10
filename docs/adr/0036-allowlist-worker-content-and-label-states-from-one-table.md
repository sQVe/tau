# ADR 0036: Allowlist worker content and label states from one table

**Date**: 2026-09-21\
**Status**: Accepted\
**Related**: [ADR 0028 (Keep worker control in the parent)](./0028-keep-worker-control-in-the-parent.md),
[ADR 0033 (Use one generic native worker workflow)](./0033-use-one-generic-native-worker-workflow.md)

## Context

Subagent tools return one result object for two readers: the parent model and the pilot.

The parent model needs a small, stable set of fields to choose its next call. Worker records keep
gaining fields, and many are paths or audit data the model should not read.

The pilot needs a short line per step and details on demand.
[ADR 0028](./0028-keep-worker-control-in-the-parent.md) keeps worker control in the parent, so only
parent records prove a stop or an acknowledgement. A label that says "stopped" or shows a check mark
without that record misleads the pilot.

Nothing enforces a size target for worker reports, and each notice and status result repeats the
report. Across 356 saved reports, summary and evidence together have a median of about 5,000
characters.

## Decision

Build model content for subagent tools and notices from an explicit allowlist in `presentation.ts`.
Keep the full record in `details` for renderers, and take all state wording from one label table.
This costs an allowlist entry per field the model needs, but new fields stay out of model content
until someone adds them on purpose.

Cap the report the model sees, mark the cut, and point to the saved report. The model reads the rest
on demand, and short reports stay unchanged.

### Model content

- Copy named fields one by one. Do not filter by key name, delete keys from a copy, or infer the
  result shape.
- Omit absent fields. Keep full task IDs.
- Keep instruction prose in tool descriptions, not in results.
- Send notices as status snapshots. A notice without `state` means the parent could not read the
  task records, and it carries `recovery` instead.

### Worker reports

- Cap `report.summary` and `report.evidence` in model content at 8,000 characters together. The
  summary takes the budget first, then evidence in order. A summary over the cap keeps its start and
  its end, because Concerns come last.
- When the cap cuts a report, add `truncated: true` and `reportFile`, the path of the saved
  `report.json`.
- Keep the full report in `details` and in the saved record. Section checks read the full report.
- Keep notices as JSON, so worker text stays apart from Tau's fields.

The cap is twice the profiles' 4,000-character report target and leaves 288 of 356 saved reports
(81%) unchanged.

### Labels

- Take every state icon and word from `stateLabels` in `presentation.ts`.
- Show a check mark only for a stopped worker whose report says success.
- Credit the worker for reported outcomes. Say "stopped" or "acknowledged" only when a parent record
  proves it.
- Keep JSON, paths, and full task IDs out of collapsed lines, except in states that need manual
  recovery.

## Consequences

### Positive

- New record fields stay out of model content until they are added to the allowlist on purpose.
- Tools and notices use the same wording for the same state.
- A long report costs the parent at most the cap per notice, and the model can still read the rest.
- Renderers read `details`, so model content can shrink without breaking the pilot's view.

### Negative

- A capped report can drop evidence the parent needs until it reads `reportFile`.
- Each field the model needs takes an allowlist entry and a test.
- A renderer that throws falls back to Pi's default rendering without an error, so render tests must
  cover every state.

## Alternatives considered

### Return the full record and filter it

Return the full record and filter it by key name or delete known keys. Rejected because every new
field reaches the model by default, and a reused key name changes behavior silently.

### Renderer-specific state wording

Let each renderer word its own states. Rejected because the same state can read differently across
tools and notices, and a renderer can claim a stop the records do not prove.

### Pass every report through whole

Pass every report through whole. Rejected because one long report fills the parent's context again
with every notice and status call.
