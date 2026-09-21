# ADR 0036: Allowlist worker content and label states from one table

- Status: Proposed
- Date: 2026-09-21

## Context

Subagent tools return one result object that serves two readers. The parent model needs a small,
stable set of fields to choose its next call. The pilot needs a short line per step and details on
demand. Worker records keep gaining fields: capacity, placement, generic harness evidence, and
recovery references. Many of these fields are paths or audit data the model should not read.

Status wording has a second constraint. ADR 0028 keeps worker control in the parent, and only parent
records prove a stop or an acknowledgement. A label that says "stopped" or shows a check mark
without that record misleads the pilot.

## Options considered

- Return the full record and filter it by key name or delete known keys. This needs no new code per
  field, but every new field reaches the model by default. A reused key name changes behavior
  silently.
- Let each renderer word its own states. This keeps renderers independent, but the same state can
  read differently across tools and notices. A renderer can claim a stop the records do not prove.
- Build model content from an explicit allowlist, keep the full record in `details`, and take all
  state wording from one label table. This costs an allowlist entry per field the model needs, but
  new fields stay out of model content until someone adds them on purpose.

## Decision

Build model content for subagent tools and notices from an explicit allowlist in `presentation.ts`.
Keep the full record in `details` for renderers.

### Model content

- Copy named fields one by one. Do not filter by key name, delete keys from a copy, or infer the
  result shape.
- Omit absent fields. Keep full task IDs.
- Keep instruction prose in tool descriptions, not in results.
- Send notices as status snapshots. A notice without `state` means the parent could not read the
  task records, and it carries `recovery` instead.

### Labels

- Take every state icon and word from `stateLabels` in `presentation.ts`.
- Show a check mark only for a stopped worker whose report says success.
- Credit the worker for reported outcomes. Say "stopped" or "acknowledged" only when a parent record
  proves it.
- Keep JSON, paths, and full task IDs out of collapsed lines, except in states that need manual
  recovery.

## Tradeoffs

- New record fields stay out of model content until they are added to the allowlist on purpose.
- Tools and notices use the same wording for the same state.
- Renderers read `details`, so model content can shrink without breaking the pilot's view.
- Cost: each field the model needs takes an allowlist entry and a test.
- Cost: a renderer that throws falls back to Pi's default rendering without an error, so render
  tests must cover every state.

## See also

- [ADR 0028: Keep worker control in the parent](./0028-keep-worker-control-in-the-parent.md)
- [ADR 0033: Use one generic native worker workflow](./0033-use-one-generic-native-worker-workflow.md)
