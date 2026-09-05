# Tau

Tau is an opinionated workflow governor for [pi](https://github.com/badlogic/pi-mono).

Pi was not enough. We wanted stronger defaults, stricter flow enforcement, and a more consistent way
of working.

Tau starts with one hard problem: enforcing strict TDD cleanly and reliably.

- write a failing test first
- prove the failure
- implement the minimum change
- prove the pass
- optionally refactor safely

Tau is not a general agent framework. Pi provides the runtime; Tau provides the workflow.

<!-- prettier-ignore -->
> [!IMPORTANT]
> Tau is under active development. Expect churn, rough edges, and changing interfaces while the core ideas take shape.

See [vision](./docs/foundations/vision.md) and [docs](./docs/README.md).

## Development

Use Node.js 24.11 or newer and pnpm 10.33.0, as declared in `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` runs TypeScript, lint, declaration-order rules, formatting, and all tests. Use
`pnpm format` to format files and `pnpm test:smoke` to check package loading through Pi. Pi loads
the TypeScript source directly; there is no build step.

To try Tau in an interactive Pi session from this checkout:

```sh
pnpm exec pi --no-extensions --no-skills -e ./src/extensions/index.ts --skill ./skills/commit
```

For use in another project, run `pi install -l /absolute/path/to/tau` there, then start Pi. This
records the local package in that project's `.pi/settings.json`.

For a manual smoke test, use a disposable Git repository with Tau installed. Ask Pi to commit a
specific changed file through `/commit`; check that it requests confirmation and creates one commit
after approval. Ask it to run raw `git commit` through bash and check that Tau blocks the call.

The commit extension is active. TDD currently has config, workspace state, shell parsing, and a
Vitest adapter; phase enforcement and the `run_tests` tool are not wired into Pi yet.

## Maintenance

Linting and formatting are configured in `vite.config.ts`. The Oxlint and Oxfmt overrides select the
updated versions throughout Vite+. Keep the direct Vitest version aligned with Vite+'s bundled
version and the override in `pnpm-workspace.yaml`; the TDD adapter resolves Vitest from the target
project.

Tau is private. Changesets opens version PRs; the workflow does not publish to npm. Add a changeset
with `pnpm changeset` for user-facing changes. CI requires one for changes under `src/`, `skills/`,
or `vendor/`; tooling and dependency maintenance can merge without one.
