# Bug

Use this shape for a defect a person should see. Start the title with `Fix <symptom>`. Leave out
optional sections that have nothing to say.

```markdown
One sentence on the symptom and who sees it.

## Reproduction

1. An exact step.

## Expected

What should happen.

## Actual

What happens, with the error or output.

## Cause

Optional. The cause with `file:line`, only when evidence shows it.

## Acceptance

- [ ] A test reproduces the symptom and passes after the fix.
```
