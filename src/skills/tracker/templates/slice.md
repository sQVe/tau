# Slice

Use this shape for a human sub-ticket of a container that one branch and one PR deliver. For a
design with one slice, the ticket is the slice, and its `## Design` holds the design. Name results,
not files or functions: the agent tickets choose those when the slice starts.

```markdown
## Goal

One or two sentences on what the slice makes true when it merges.

## Design

Optional. The rules and decisions the slice follows.

## Delivers

- A behavior or result a reviewer can check in the PR.

## Out of scope

Work that belongs to another slice or to no slice.

## Acceptance

- [ ] An observable result that shows the slice is done.
```
