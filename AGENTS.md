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
- Follow the [writing instructions](src/extensions/writing/instructions.md) for every document.
- Before finishing a document, check its local links and verify the commands it gives against the
  repository.

## Tests

Keep tests fast so the full suite stays practical as coverage grows.

- Test behavior a user, agent, Pi, or Git can observe. If a failure would break nothing for them, do
  not write the test.
- Do not test wording, constants, types, removed features, or internal calls. Assert exact bytes
  only where another program parses them.
- For a refusal, assert the error and that nothing changed.
- Assert after the call, never inside a fake that production code may catch.
- Keep tests next to source. Cross-module and package checks go in `tests/`.
- Use real Git, filesystem, and Pi where those boundaries matter. Otherwise avoid subprocesses and
  reuse existing fakes, such as `src/extensions/subagents/fixtures/herdrFake.ts`.
- Create Git repositories with `tests/gitRepository.ts`.
- Fake timers, `Date`, and `performance` together, and use explicit signals for async work. Use real
  time only when elapsed time is the behavior.
- Keep mutable fixtures isolated. Never drop assertions or failure cases to save time.
- Measure slow tests before optimizing. Split a slow test file by behavior when it prevents workers
  from sharing the work. Compare repeated full-suite runs before changing worker limits.
