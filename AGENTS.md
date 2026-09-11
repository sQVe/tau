# Tau

Pi extensions and skills. Read [the development guide](docs/development.md) for local setup and
verification.

- Run `pnpm check` before finishing changes. It includes typechecking, lint, formatting, and tests.
  Tests use temporary directories and need no model API.
- Format with `pnpm format`; configuration lives in `vite.config.ts`.
- Follow the structure and naming decisions in [docs/adr](docs/adr/README.md). Read that guide
  before adding an ADR. Do not write documents that explain how a feature works; see
  [ADR 0010](docs/adr/0010-documentation-scope.md).
- Name values in camelCase and types in PascalCase. Never SCREAMING_CASE, not even for module
  constants.
- Keep tests next to source; package and cross-module checks belong in `tests/`.
- Follow the [writing instructions](src/extensions/writing/instructions.md) for every document.
- Before finishing a document, check its local links and verify the commands it gives against the
  repository.

`CLAUDE.md` links to this file. Edit `AGENTS.md` to update instructions for both agents.
