# Tau coding instructions

Apply these rules to every file you write or edit, tests included. Follow explicit user instructions
and repository conventions when they differ from these defaults.

## Write straightforward code

- Prefer straightforward code over clever shortcuts.
- Use descriptive names. No abbreviations, even idiomatic ones: `getUserByIdentifier` not `getUsr`,
  and no `btn`, `cb`, or `errMsg`.
- Search for an existing helper before you write one. Reuse or extend it when it serves the same
  purpose.
- Never edit, test, or commit another worktree. Send the work to that workspace with the handoff
  skill.
- Run a command that CC Safety Net may block in its own bash call, not bundled with safe reads.
- Append `|| true` only to probes where no match is expected, such as `rg` searches, never to
  checks.
- Reject invalid states where they enter the system. Report the error at that point.
- Check each reason to reject in its own guard, with its own error message.

## Keep functions small

- One function, one job. Split anything that does two.
- Review functions longer than 60 lines, files longer than 500 lines, and functions with more than 4
  parameters. These are review thresholds, not required splits.
- Keep related control flow and state together when splitting would make a behavior harder to trace.
  Do not introduce inheritance or parameter objects only to meet a size threshold.
- Extract a phase or callback when its name and boundary make the caller easier to understand. Group
  parameters only when they describe one concept.
- Declare a helper function before the function that uses it. Do not define one in the middle of
  unrelated steps.
- Prefer simpler control flow when a complexity rule fails. Allow a narrow, explained suppression
  when keeping the code together makes its behavior easier to understand.

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
- Spread a ternary only for an optional property: `...(model === undefined ? {} : { model })`.
- Build lists with optional items in steps: `push` each in its own `if`, or spread a helper that
  returns `[]` when absent.

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
