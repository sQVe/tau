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

- Make each test defend one behavior a user, agent, Pi, or Git can observe. If you cannot say what
  breaks for them when the test fails, do not write it.
- Do not test prompt or instruction wording, constants, types the compiler checks, removed features,
  or internal call counts and argument order. Assert exact bytes only where another program parses
  them.
- For every refusal, assert the error and that nothing else changed: no new files, no changed bytes,
  no herdr or Git mutations.
- Do not put `expect` inside a fake or callback whose errors production code may catch. Record the
  value and assert after the call.
- Keep tests next to source; package and cross-module checks belong in `tests/`.
- Test logic without subprocesses when the process itself is not part of the behavior. Reuse
  existing fakes rather than building a second implementation in mocks.
- Keep real Git, filesystem, and Pi integration tests where those boundaries matter. Do not remove
  assertions or skip failure cases to save time.
- Create Git repositories with `tests/gitRepository.ts`. `vite.config.ts` sets the Git environment
  for every test process, so Git ignores user and system configuration, also in the code under test.
- Use fake timers for time-based logic, faking `Date` and `performance` together, and explicit
  signals for async coordination. Keep real timers where elapsed time or process termination is the
  behavior under test.
- Keep mutable fixtures isolated. Reduce repeated setup work without sharing repositories that tests
  can change.
- Measure slow tests before optimizing. Split a slow test file by behavior when it prevents workers
  from sharing the work. Compare repeated full-suite runs before changing worker limits.

`CLAUDE.md` links to this file. Edit `AGENTS.md` to update instructions for both agents.
