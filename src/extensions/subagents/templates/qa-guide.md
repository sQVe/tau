# QA guide

Use this shape for a repository's QA guide, `.pi/qa.md`. Use these exact headings, in this order.
Leave out a part marked optional when it has nothing to say. Tau does not parse the guide, the
feature files, or the journeys, so the headings are a convention for readers.

```markdown
# QA guide

One or two sentences: what this repository ships and which interfaces a user can reach.

## Choose sections

| Section | Test it when the change touches |
| ------- | ------------------------------- |

Cross-effects:

- Each effect that a path match misses, one per line.

No launch, and unclear impact:

- The changes that need no `qa` launch.
- When the impact on a section is unclear, include the section.

## Journeys

Optional. Index the journeys in `.pi/qa/journeys/`.

| Journey | Goal | Run it when the change touches | Test |
| ------- | ---- | ------------------------------ | ---- |

## Features

Optional. Index the feature files at `.pi/qa/features/<name>.md`.

| Feature | Section | Target | Update it when the change touches |
| ------- | ------- | ------ | --------------------------------- |

## Before a launch

Optional. For the manager, because the `qa` worker builds, starts, and stops nothing.

A section with a target needs no bullet here: the manager launches the target with the
`verification` tool.

The manager starts, for a section whose target is `none`:

- <Section name, or the thing to start>
  - Start: the exact command.
  - Check that it is up: the exact command and the output it must print.
  - Stop: the exact command.

Ask the user:

- Each step that only the user may do, with its reason.

Then the lines the brief must give, such as a sandbox name, a path, an account, or a permission
beyond data writes, such as "paid calls allowed".

## Rules for every section

Optional. The rules that all sections share: the shared "never" list, what counts as a data write in
this repository, and a shared way to reach or prove the instance.

## <Section name>

Target: <the `verification.targets` entry in `.pi/tau.json` that serves this section, or `none`>

### Reach it

### Use it safely

### What to check

### Features

- [<Feature name>](./features/<name>.md)

## Not testable

Optional. What a `qa` worker cannot reach, each with its reason. The worker reports these as not
verified and never tries them through another path.
```

## Rules

- A section is an area to test: an interface, a way to run it, or a feature area of one interface.
- A feature file is a check of one feature.
- A journey is one user goal across features, through several commands or screens.
- A section may drop an empty subsection, or say "same as <section>" for one.
- "Reach it" holds the proof that the running instance serves this worktree, as exact commands with
  the expected output. It tells the worker to stop and ask the parent when the proof fails.
- A step goes under "The manager starts" only when it reads no secret, costs no money, and touches
  no state that another worktree, another person, or the user's real environment shares. Every other
  step goes under "Ask the user".
- A section whose target is `none` needs a bullet under "The manager starts" for each thing to
  start, or one per section, so the manager starts only what the assigned sections need.
- Give each bullet under "The manager starts" three labeled lines: Start, Check that it is up, and
  Stop.
- Mark a section done only after you tried it against a running instance. Do not commit a guide with
  an untried section, and do not report it as done. When the app is not running, ask the user to
  start it and wait.
- A section that no local instance can serve goes under "Not testable".
- Do not repeat the rules of a tool that ships its own text for QA, such as a sandbox tool like
  ruta. Name the command or file that holds them, and keep only what is specific to the repository.
- Give exact commands and visible results. Write nothing that the `qa` worker's limits forbid, and
  no general QA method.
- Aim for at most about 150 lines. Move detail that only one feature needs into its feature file
  under `.pi/qa/features/<name>.md`. Shorten a "Choose sections" cell that runs past two lines by
  moving its cross-effects into the "Cross-effects" list.
- A feature file at `.pi/qa/features/<name>.md` has six parts: Target, Entry points, Driving steps
  (numbered, each with the action and its visible result), Observable results, End state (what
  proves the feature works), and Gotchas.
- The numbered steps of a feature file's Driving steps, or of a journey's Steps, are the step count
  the manager registers.
- A journey step may link a feature file.
- A journey file at `.pi/qa/journeys/<name>.md` has five parts: Who, Goal, Test (a file path, or "by
  hand" with the reason), Steps (numbered, each with the action and its visible result), and End
  state (what proves the goal).
- A journey file names only visible results.
- Aim for at most eight journeys per product. A product with three real goals writes three journeys.
- A case for one command stays a normal test, not a journey.
- Include a trouble journey when the product has failure paths.
