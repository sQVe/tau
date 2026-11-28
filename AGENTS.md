# Tau

Pi extensions and skills. Read [the development guide](docs/development.md) for local setup and
verification.

- The PR step runs `pnpm check`. It includes typechecking, lint, formatting, and tests. Tests use
  temporary directories and need no model API.
- Format with `pnpm format`; configuration lives in `vite.config.ts`.
- Follow the structure and naming decisions in [docs/adr](docs/adr/README.md), and record new
  decisions there. Read that guide before adding an ADR. Do not write documents that explain how a
  feature works; see [shared ADR 0001](docs/stomme/shared/adr/0001-documentation-scope.md).
- Follow the [writing instructions](src/instructions/writing.md) for every document.
- Follow the [workflow instructions](src/instructions/workflow.md) for how you run commands and
  scope work.
- Before finishing a document, verify the commands it gives against the repository.
- Before finishing a document, check that its local links resolve. `tests/markdownFiles.test.ts`
  checks them.
- A pull request that touches `src/` needs a changeset, except the release pull request from
  `changeset-release/main` or titled `chore: release version packages`. Add it with
  `pnpm changeset`; `.github/workflows/changeset.yml` requires it.
- Follow the module conventions in
  [ADR 0120](docs/adr/0120-capability-modules-with-an-enforced-import-table.md) and the query and
  failure conventions in [ADR 0055](docs/adr/0055-record-tau-coding-conventions-in-agents-md.md).
  Give each new public read path over saved records or running workers a contract test for normal,
  missing, and malformed evidence.
- Write a new decision rule as a pure function in a module registered in
  `tests/pureModuleRegistry.ts`, tested with a decision table like
  `src/extensions/subagents/workerDecision.test.ts`. The caller reads records, the clock, and the
  environment, and passes the values in as facts
  ([ADR 0120](docs/adr/0120-capability-modules-with-an-enforced-import-table.md)).
- Change a saved record format with a new version and fixtures, except the lock owner record, which
  stays unversioned ([ADR 0053](docs/adr/0053-version-each-saved-record-format.md)).
- Keep an extension's registration root, any file Pi loads as an extension, to registration, wiring,
  and order that must stay central. Put each action's policy and execution in a behavior owner file
  that the root calls, and keep coupled state changes in one owner
  ([ADR 0109](docs/adr/0109-keep-action-behavior-out-of-extension-roots.md)).
- Give a prompt or guidance list one policy per item.
- Name one concept with one noun inside a module. No file reverses its module's name
  ([ADR 0120](docs/adr/0120-capability-modules-with-an-enforced-import-table.md)).

## Architecture

`src/tau.ts` is the entry point. It selects the registration in `src/tau/tau.ts`, which registers
each extension. `src/extensions/` is the open feature tier, with one folder or file per feature.
Shared modules never import extensions, no module imports `src/tau.ts`, and extensions never import
each other ([ADR 0120](docs/adr/0120-capability-modules-with-an-enforced-import-table.md)).

Shared code under `src/` forms capability modules. The module list and import table live in
`stomme.toml` ([ADR 0120](docs/adr/0120-capability-modules-with-an-enforced-import-table.md)). Until
`@sqve/stomme-ts-imports` ships, `tau/module-boundaries` in `lint/rules/moduleBoundaries.ts`
enforces them, and `tests/stommeModules.test.ts` keeps the two copies equal. When the rule reports
an import, change the import table or the module list instead of silencing the rule.

## Skills and tools

Skills live in `src/skills/<name>/SKILL.md`. A skill's tool lives in an extension under
`src/extensions/<feature>/`, and `src/tau.ts` calls that extension. Its skill and tool names go in
`src/skillTools.json`. Before writing or changing a skill, or a tool that a skill calls, read the
[skill authoring guide](docs/skill-authoring.md).

## Tests

Keep tests fast so the full suite stays practical as coverage grows.

- Do not test wording, constants, types, removed features, or internal calls. Assert exact bytes
  only where another program parses them.
- Keep tests next to source. Cross-module and package checks go in `tests/`.
- Give a script under `scripts/` tests for its argument handling and its failure output.
- Name a unit test `<owner>.test.ts` or `<owner><Behavior>.test.ts`. Never name a file after a test
  technique.
- Put every case in the decision table. The adapter test holds one case per outcome kind and its
  side effects.
- Put a fixture used by one module in that module's `fixtures/`. Put a fixture used by two modules
  or by `tests/` in `tests/`.
- Use real Git, filesystem, and Pi where those boundaries matter. Otherwise avoid subprocesses and
  reuse existing fakes, such as `tests/hcFake.ts`.
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

## Rule table

Each local rule with a check appears once here. The prose above is authoritative. Rules without a
check are owned by the human reviewer.

Shared coding, writing, and workflow rules live in [stomme](https://github.com/sQVe/stomme).

| Rule                                                                 | Enforced by                                                     |
| -------------------------------------------------------------------- | --------------------------------------------------------------- |
| Run the full check before a pull request                             | `pnpm check`                                                    |
| Format with `pnpm format`                                            | `pnpm format:check`                                             |
| Check that local links resolve                                       | `tests/markdownFiles.test.ts`                                   |
| Add a changeset for a `src/` change                                  | `.github/workflows/changeset.yml`                               |
| Keep modules and imports inside the import table                     | `lint/rules/moduleBoundaries.ts`, `tests/stommeModules.test.ts` |
| Change the import table or module list instead of silencing the rule | `lint/rules/moduleBoundaries.ts`                                |
| Keep a registered pure module free of reads and effects              | `tests/structure.test.ts`                                       |
| Version each saved record format with fixtures                       | `tests/structure.test.ts`                                       |
| Keep fixtures out of production modules                              | `tests/structure.test.ts`                                       |

<!-- prettier-ignore-start -->
<!-- stomme:start -->
# Shared rules

- Run the full check before finishing changes: `pnpm check`.
- Format with the `format` script in `package.json`.
- Follow the decisions in [docs/adr](docs/adr/README.md).
- Follow the shared ADRs in [docs/stomme/shared/adr](docs/stomme/shared/adr/README.md).
- Record new decisions in [docs/adr](docs/adr/README.md).
- Edit an ADR in place when its details change.
- Comment only what the code cannot say. Never describe history.
- Document decisions, not features. See [ADR 0001](docs/stomme/shared/adr/0001-documentation-scope.md).
- Read [the general guide](docs/stomme/shared/coding.md).
- Read [the TypeScript guide](docs/stomme/languages/typescript/guide.md).
- Read [the pi guide](docs/stomme/layers/pi/guide.md).
<!-- stomme:end -->
<!-- prettier-ignore-end -->
