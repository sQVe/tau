# QA guide

Use this shape for a repository's QA guide, `.pi/qa.md`. Use these exact headings, in this order.
Leave out a part marked optional when it has nothing to say. Tau does not parse the guide, so the
headings are a convention for readers.

```markdown
# QA guide

One or two sentences: what this repository ships and which interfaces a user can reach.

## Choose sections

| Section | Test it when the change touches |
| ------- | ------------------------------- |

Cross-effects:

- Each effect that a path match misses, one per line.

- The changes that need no `qa` launch.
- When the impact on a section is unclear, include the section.

## Journeys

Optional. Index the journeys in `.pi/qa/journeys/`.

| Journey | Goal | Run it when the change touches | Test |
| ------- | ---- | ------------------------------ | ---- |

## Before a launch

Optional. For the manager, because the `qa` worker builds, starts, and stops nothing.

The manager starts:

| Section | Start | Check that it is up | Stop |
| ------- | ----- | ------------------- | ---- |

Ask the user:

- Each step that only the user may do, with its reason.

Then the lines the brief must give, such as a sandbox name, a path, an account, or a permission
beyond data writes, such as "paid calls allowed".

## Rules for every section

Optional. The rules that all sections share: the shared "never" list, what counts as a data write in
this repository, and a shared way to reach or prove the instance.

## <Section name>

### Reach it

### Use it safely

### What to check

### Recipes

## Not testable

Optional. What a `qa` worker cannot reach, each with its reason. The worker reports these as not
verified and never tries them through another path. When only this part applies to a change, the
manager launches no `qa` worker and reports that QA did not run, with the reason.
```

## Rules

- A section is an interface, a way to run it, or a feature area of one interface.
- A section may drop an empty subsection, or say "same as <section>" for one.
- "Reach it" holds the proof that the running instance serves this worktree, as exact commands with
  the expected output. It tells the worker to stop and ask the parent when the proof fails.
- A step goes under "The manager starts" only when it reads no secret, costs no money, and touches
  no state that another worktree, another person, or the user's real environment shares. Every other
  step goes under "Ask the user".
- List the steps under "The manager starts" per section, so the manager starts only what the
  assigned sections need.
- A section is done only after you tried it against a running instance. Do not commit a guide with
  an untried section, and do not report it as done. When the app is not running, ask the user to
  start it and wait.
- A section that no local instance can serve goes under "Not testable".
- Do not repeat the rules of a tool that ships its own text for QA, such as a sandbox tool like
  ruta. Name the command or file that holds them, and keep only what is specific to the repository.
- Give exact commands and visible results. Write nothing that the `qa` worker's limits forbid, and
  no general QA method.
- Aim for at most about 150 lines. Move detail that only one feature needs into a recipe under
  `.pi/qa/`. Shorten a "Choose sections" cell that runs past two lines by moving its cross-effects
  into the list under the table.
- A recipe under `.pi/qa/` has four parts: Entry points, Driving steps, Observable results, and
  Gotchas.
- A journey is a user goal that crosses several commands or screens.
- A journey file at `.pi/qa/journeys/<name>.md` has five parts: Who, Goal, Test (a file path, or "by
  hand" with the reason), Steps (numbered, each with the action and its visible result), and End
  state (what proves the goal).
- A journey file names only visible results.
- Keep five to eight journeys per product.
- A case for one command stays a normal test, not a journey.
- Include a trouble journey when the product has failure paths.
