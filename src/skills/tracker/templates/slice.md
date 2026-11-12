# Slice

Use this shape for a human sub-ticket of a container that one branch and one PR deliver. For a
design with one slice, the ticket is the slice, and its `## Design` holds the design. Name results,
not new files or functions, except the journey and test paths in journey acceptance items. The agent
tickets choose other files when the slice starts. `## Design` may name existing modules and helpers
the slice reuses. Aim for about 250 words, and put longer details in linked files. For one slice,
keep each whole planned journey in `## Design`, using the
[QA-guide template's journey shape](../../../extensions/subagents/templates/qa-guide.md#rules).

```markdown
## Goal

One or two sentences on what the slice makes true when it merges.

## Design

Optional. The rules and decisions the slice follows. Link applicable records with their constraints,
one line each; do not copy their contents.

## Delivers

- A behavior or result a reviewer can check in the PR.

## Out of scope

Work that belongs to another slice or to no slice.

## Acceptance

- [ ] An observable result that shows the slice is done.
- [ ] Journey <name>, steps <first>-<last>: <expected visible results>. Journey file:
      `.pi/qa/journeys/<name>.md`. Test: <test file path, or "by hand">. For the slice with the last
      step, also require that the end state holds and the whole journey passes.
```
