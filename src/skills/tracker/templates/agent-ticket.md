# Agent ticket

Use this shape for a sub-ticket of a slice that one worker carries out. The worker reads only this
ticket, so name files, signatures, tests, and checks exactly. Write a fully specified ticket: it
decides every design choice, which lets a worker route pick a cheaper model. A ticket that leaves
judgment open routes to a stronger one. Aim for about 400 words, and put longer details in linked
files.

```markdown
## Outcome

One or two sentences on what is true when the worker is done.

## Constraints

Optional. Linked records and rules this worker needs, one line each.

## Files

- `path/to/file.ts`: what changes in it, and the existing pattern or helper to copy.
  - Signature: `functionName(input: InputType): ResultType`, new or changed.
  - Data shape: the fields of a new or changed type or record.
  - Error cases: each invalid input and the error it gives.

## Test cases

1. `test name`, in `path/to/file.test.ts`: input, and the expected result. Write this one first.
2. `test name`: input, and the expected result.

## Acceptance

- [ ] A check the worker runs, such as a test name or a command, and its expected result.
```
