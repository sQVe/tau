# Tau

Pi extensions and skills. Read [the development guide](docs/development.md) for local setup and
verification.

- Run `pnpm check` before finishing changes. It includes typechecking, lint, formatting, and tests.
  Tests use temporary directories and need no model API.
- Format with `pnpm format`; configuration lives in `vite.config.ts`.
- Follow the structure and naming decisions in [docs/adr](docs/adr/README.md), and record new
  decisions there. Read that guide before adding an ADR. Do not write documents that explain how a
  feature works; see [ADR 0010](docs/adr/0010-documentation-scope.md).
- Name values in camelCase and types in PascalCase. Never SCREAMING_CASE, not even for module
  constants.
- Follow the [coding instructions](src/instructions/coding.md) for all code. Pi loads them through
  Tau; other agents must read the file.
- Follow the [writing instructions](src/instructions/writing.md) for every document.
- Follow the [workflow instructions](src/instructions/workflow.md) for how you run commands and
  scope work.
- Before finishing a document, verify the commands it gives against the repository.
- Before finishing a document, check that its local links resolve. `tests/markdownFiles.test.ts` in
  `pnpm check` checks them.
- A pull request that changes `src/` needs a changeset. Add it with `pnpm changeset`;
  `.github/workflows/changeset.yml` requires it.
- Follow the module, query, and failure conventions in
  [ADR 0055](docs/adr/0055-record-tau-coding-conventions-in-agents-md.md). Give each new public read
  path over saved records or running workers a contract test for normal, missing, and malformed
  evidence.
- Write a new decision rule as a pure function in a module registered in `tests/structure.test.ts`,
  tested with a decision table like `workerState.test.ts`. The caller reads records, the clock, and
  the environment, and passes the values in as facts
  ([ADR 0120](docs/adr/0120-capability-modules-with-an-enforced-import-table.md)).
- Change a saved record format with a new version and fixtures
  ([ADR 0053](docs/adr/0053-version-each-saved-record-format.md)).
- Keep an extension's registration root, any file Pi loads as an extension, to registration, wiring,
  and order that must stay central. Put each action's policy and execution in a behavior owner file
  that the root calls, and keep coupled state changes in one owner
  ([ADR 0109](docs/adr/0109-keep-action-behavior-out-of-extension-roots.md)).
- Give a prompt or guidance list one policy per item.
- Name one concept with one noun inside a module. No file reverses its module's name
  ([ADR 0109](docs/adr/0109-keep-action-behavior-out-of-extension-roots.md)).

## Architecture

`src/tau.ts` is the entry point. It registers each extension. `src/extensions/` is the open feature
tier, with one folder or file per feature. Shared modules never import extensions, no module imports
`src/tau.ts`, and extensions never import each other
([ADR 0120](docs/adr/0120-capability-modules-with-an-enforced-import-table.md)).

Shared code under `src/` forms capability modules, and `tau/module-boundaries` in
`lint/rules/moduleBoundaries.ts` enforces them
([ADR 0120](docs/adr/0120-capability-modules-with-an-enforced-import-table.md)). The rule keeps a
closed module list and an import table. The target shared modules are `errors`, `schema`, `command`,
`skillTools`, `instructions`, `herdr`, `codemode`, `worker`, `git`, `config`, `linear`, `dialog`,
`tauDirectory`, `github`, `reviewCapture`, `record`, `process`, `shell`, and `checkRecord`. When the
rule reports an import, change the import table or the module list instead of silencing the rule.

## Skills and tools

Skills live in `src/skills/<name>/SKILL.md`. A skill's tool lives in an extension under
`src/extensions/<feature>/`, and `src/tau.ts` calls that extension. Its skill and tool names go in
`src/skillTools.ts`. Before writing or changing a skill, or a tool that a skill calls, read the
[skill authoring guide](docs/skill-authoring.md).

## Tests

Keep tests fast so the full suite stays practical as coverage grows.

- Do not test wording, constants, types, removed features, or internal calls. Assert exact bytes
  only where another program parses them.
- Keep tests next to source. Cross-module and package checks go in `tests/`.
- Name a unit test `<owner>.test.ts` or `<owner><Behavior>.test.ts`. Never name a file after a test
  technique.
- Put every case in the decision table. The adapter test holds one case per outcome kind and its
  side effects.
- Put a fixture used by one module in that module's `fixtures/`. Put a fixture used by two modules
  or by `tests/` in `tests/`.
- Use real Git, filesystem, and Pi where those boundaries matter. Otherwise avoid subprocesses and
  reuse existing fakes, such as `src/extensions/subagents/fixtures/herdrFake.ts`.
- Fake the boundary, not the module. Assert outcomes, and read a `calls` list only when the call is
  the behavior.
- Create Git repositories with `tests/gitRepository.ts`.
- Fake timers, `Date`, and `performance` together, and use explicit signals for async work. Use real
  time only when elapsed time is the behavior.
- Follow [ADR 0121](docs/adr/0121-test-architecture-rules.md) for test placement, naming, fakes, and
  fixtures.
- Keep mutable fixtures isolated. Never drop assertions or failure cases to save time.
- Measure slow tests before optimizing. Split a slow test file by behavior when it prevents workers
  from sharing the work. Compare repeated full-suite runs before changing worker limits.
