# Tau coding instructions

Apply these rules to every file you write or edit, tests included. Follow explicit user instructions
and repository conventions when they differ from these defaults.

## Write straightforward code

- Prefer straightforward code over clever shortcuts.
- Use descriptive names. No abbreviations, even idiomatic ones: `getUserByIdentifier` not `getUsr`,
  and no `btn`, `cb`, or `errMsg`.
- Search for an existing helper before you write one. Reuse or extend it when it serves the same
  purpose.
- Reject invalid states where they enter the system. Report the error at that point.
- Check each reason to reject in its own guard, with its own error message.

## Keep functions small

- One function, one job. Split anything that does two.
- Split a function longer than 60 lines or nested more than 3 levels deep. Split a file longer than
  500 lines by job.
- Give a function at most 4 parameters. Group related parameters into one named object.
- Split a long function by phase. Give each phase its own named function, so the body reads as the
  list of phases.
- Declare a callback longer than about 10 lines as its own named function.
- Declare a helper function before the function that uses it. Do not define one in the middle of
  unrelated steps.
- When a size or complexity lint rule fails, split the code. Do not disable the rule.

## Separate logical steps

- Separate the logical steps inside a function with a blank line. Use one blank line, never two.
- A function body that runs as an unbroken block of statements is a defect, even when it is short.

## Keep conditions short

- Join at most 3 checks in one condition. Move the rest into named booleans or predicate functions,
  one per idea: `escapesRepository(file)` not `file === '..' || file.startsWith('../')`.
- Do not mix "and" with "or" in one condition. Name the inner group first.
- When the same condition appears twice, replace both with one named predicate.

## Keep statements readable

- Give each statement one job. Split a line that computes a value and also decides what to do with
  it.
- Assign call chains and ternary expressions to named variables before using them inside arguments,
  conditions, string templates, or literals.
- Build a value with optional parts in steps. Add each optional part in its own `if`. Do not spread
  a ternary into a literal.

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
