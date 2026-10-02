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
- Before writing or changing a skill, read the [skill authoring guide](docs/skill-authoring.md).
- Before finishing a document, check its local links and verify the commands it gives against the
  repository.
- Follow the module, query, and failure conventions in
  [ADR 0055](docs/adr/0055-record-tau-coding-conventions-in-agents-md.md). Give each new public read
  path over saved records or running workers a contract test for normal, missing, and malformed
  evidence.
- Write a new decision rule as a pure function in a module registered in `tests/structure.test.ts`,
  tested with a decision table like `workerState.test.ts`. The caller reads records, the clock, and
  the environment, and passes the values in as facts
  ([ADR 0057](docs/adr/0057-enforce-pure-decision-modules-from-a-registry.md)).
- Change a saved record format with a new version and fixtures
  ([ADR 0053](docs/adr/0053-version-each-saved-record-format.md)).

## Tests

Keep tests fast so the full suite stays practical as coverage grows.

- Do not test wording, constants, types, removed features, or internal calls. Assert exact bytes
  only where another program parses them.
- Keep tests next to source. Cross-module and package checks go in `tests/`.
- Use real Git, filesystem, and Pi where those boundaries matter. Otherwise avoid subprocesses and
  reuse existing fakes, such as `src/extensions/subagents/fixtures/herdrFake.ts`.
- Create Git repositories with `tests/gitRepository.ts`.
- Fake timers, `Date`, and `performance` together, and use explicit signals for async work. Use real
  time only when elapsed time is the behavior.
- Keep mutable fixtures isolated. Never drop assertions or failure cases to save time.
- Measure slow tests before optimizing. Split a slow test file by behavior when it prevents workers
  from sharing the work. Compare repeated full-suite runs before changing worker limits.
