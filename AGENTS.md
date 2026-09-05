# Tau

Pi extensions and skills. Read [the development guide](docs/guides/development.md) for local setup
and current feature status.

- Run `pnpm check` before finishing changes. It includes typechecking, lint, formatting, and tests.
  Tests use temporary directories and need no model API.
- Format with `pnpm format`; configuration lives in `vite.config.ts`.
- Follow the structure and naming decisions in [docs/adr](docs/adr/README.md).
- Keep tests next to source; package and cross-module checks belong in `tests/`.
- Read [docs/AGENTS.md](docs/AGENTS.md) before editing documentation under `docs/`.

`CLAUDE.md` links to this file. Edit `AGENTS.md` to update instructions for both agents.
