# Agent ticket

Use this shape for a sub-ticket of a slice that one worker carries out. Name files, tests, and
checks exactly, since a cheap worker model reads only this ticket.

```markdown
## Outcome

One or two sentences on what is true when the worker is done.

## Files

- `path/to/file.ts`: what changes in it.

## First test

The test to write first, its file, and what it asserts.

## Acceptance

- [ ] A check the worker runs, such as a test name or a command, and its expected result.
```
