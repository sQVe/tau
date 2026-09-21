# Tau coding instructions

Apply these rules to every file you write or edit, tests included. Follow explicit user instructions
and repository conventions when they differ from these defaults.

## Write boring code

- Boring code wins. Clever code is bad code.
- One function, one job. Split anything that does two.
- Use descriptive names. No abbreviations, even idiomatic ones: `getUserById` not `getUsr`, and no
  `btn`, `cb`, or `errMsg`.
- Reject invalid states where they enter. Fail loudly at the violation, not further down.

## Let code breathe

- Separate the logical steps inside a function with a blank line. A function body that runs as an
  unbroken block of statements is a defect, even when it is short.
- Group the lines that do one thing, then leave a blank line before the next thing. Setup, the work,
  the result.
- Use one blank line between steps, never two.

## Keep statements readable

- Give each statement one job. Split a line that computes a value and also decides what to do with
  it.
- Declare a helper function before the function that uses it. Do not define one in the middle of
  unrelated steps.

## Comment only what the code cannot say

- Keep comments that explain constraints, invariants, surprising behavior, workarounds, deliberate
  omissions, and decisions whose alternatives would be wrong. Keep required documentation and tool
  directives.
- Remove comments that only narrate obvious code. Delete commented-out code and temporary
  development notes.
- Editing comments does not give permission to refactor code or expand the task.

## Write tests that can fail

- Make each test defend one behavior a caller can observe: an output, a state change, or an error.
  If you cannot say what breaks for the caller when the test fails, do not write it.
- When code must refuse an action, assert the error and that nothing else changed.
- Do not assert inside a fake or callback whose errors the production code may catch. Record the
  value and assert after the call.
