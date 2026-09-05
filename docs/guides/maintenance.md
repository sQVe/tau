# Maintenance

Update tooling and prepare version changes. Run commands from the Tau checkout.

## Tooling

Linting and formatting are configured in [vite.config.ts](../../vite.config.ts). Keep the direct
Vitest version aligned with Vite+'s bundled version; the TDD adapter resolves Vitest from the target
project.

## Versioning

Add a changeset for user-facing changes:

```sh
pnpm changeset
```

Describe the behavior change for users. Commit the generated file under `.changeset/` with the
change it describes.

The [changeset check](../../.github/workflows/changeset.yml) requires a changeset when a PR touches
`src/`, `skills/`, or `vendor/`. Changes confined to docs, tooling, or dependencies do not trigger
that check.

The [release workflow](../../.github/workflows/release.yml) opens version PRs and is configured to
create Git tags and GitHub releases after versioning. Tau is private and is not published to npm.
See [package scripts](../../package.json) and
[Changesets configuration](../../.changeset/config.json) for the release commands and settings.

## See also

- [Development](./development.md)
