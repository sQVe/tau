# Slice

Use this shape for a human sub-ticket of a container that one branch and one PR deliver. For a
design with one slice, the ticket is the slice: put the container's `## Design` section first, then
these sections. Name results, not files or functions: the agent tickets choose those when the slice
starts.

```markdown
## Goal

One or two sentences on what the slice makes true when it merges.

## Delivers

- A behavior or result a reviewer can check in the PR.

## Out of scope

Work that belongs to another slice or to no slice.

## Acceptance

- [ ] An observable result that shows the slice is done.
```
