# Tau coding instructions

Apply these rules to every file you write or edit, tests included. Follow explicit user instructions
and repository conventions over these defaults.

## Write straightforward code

- Before writing code, ask whether it needs to exist. Skip work for a need nobody has shown.
- Prefer deleting code over adding it.
- Use descriptive names. No abbreviations, even idiomatic: `getUserByIdentifier` not `getUsr`, and
  no `btn`, `cb`, or `errMsg`.
- Search for an existing helper before writing one; reuse or extend it when it serves the same
  purpose.
- Use the standard library or an installed dependency before adding one.
- Fix a bug once at its root cause, in the function all callers share, not only the caller the
  report names.
- Parse untrusted values once at the boundary and pass trusted types inward.
- Reject invalid states where they enter the system, and report the error there.
- Check each reason to reject in its own guard, with its own error message.

## Drop backwards compatibility by default

- On an interface change, update its callers in the repository and delete the old path.
- Do not keep deprecated aliases, optional parameters for the old call shape, branches for old
  config keys, or re-exports of moved symbols.
- Ask before choosing when something outside the repository may use the old surface: a published
  package, API, or CLI, a user config file, or data an earlier version saved.
- If deleting the old path is outside the task, say so instead of silently keeping both.

## Keep functions small

- One function, one job. Split anything that does two.
- Review functions over 60 lines, files over 500 lines, and functions with more than 4 parameters.
- Keep related control flow and state together when splitting hurts traceability.
- Do not add inheritance or parameter objects only to meet a size threshold.
- Extract a phase or callback when its name and boundary make the caller clearer.
- Declare a helper before the function that uses it; do not define one mid-unrelated-steps.
- When a linter flags complexity, simplify first. Suppress narrowly with a comment explaining why.

## Separate logical steps

- Separate the logical steps in every function with one blank line, never two.

## Keep conditions short

- Join at most 3 checks in one condition and move the rest into named booleans or predicates, one
  per idea: `escapesRepository(file)` not `file === '..' || file.startsWith('../')`.
- Do not mix "and" with "or" in one condition; name the inner group first.
- When a condition appears twice, replace both with one named predicate.

## Keep statements readable

- Give each statement one job. Split a line that computes a value from deciding what to do with it.
- Assign call chains and ternaries to named variables before using them in arguments, conditions,
  templates, or literals.
- Spread a ternary only for an optional property: `...(model === undefined ? {} : { model })`.
- Build lists with optional items step by step: `push` each in its own `if`, or spread a helper
  returning `[]` when absent.

## Comment only what the code cannot say

- Default to no comment or doc comment. Add one only when a reader would otherwise make a wrong
  change: a constraint, invariant, workaround, or surprising behavior the code cannot show.
- State the rule itself: never cite an ADR, ticket, PR, or review, and never describe the code's
  history.
- Never state a cause or measurement you have not checked in this session, even if a ticket says it.
- Never restate the name, type, or signature below the comment.
- Match the comment density and style already in the file.
- Keep required documentation and tool directives. Delete commented-out code and temporary notes.

## Write tests that can fail

- Make each test defend one observable behavior: an output, a state change, or an error. If you
  cannot say what breaks for the caller, do not write it.
- When code must refuse, assert the error and that nothing else changed.
- Do not assert inside a fake or callback whose errors the production code may catch. Record the
  value and assert after the call.
