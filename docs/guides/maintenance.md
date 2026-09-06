# Maintenance

Update tooling and prepare version changes. Run commands from the Tau checkout.

## Tooling

Linting and formatting are configured in [vite.config.ts](../../vite.config.ts). Keep the direct
Vitest version aligned with Vite+'s bundled version.

## Versioning

Tau is private, is not published to npm, and is installed from a checkout with
`pi install -l /absolute/path/to/tau`. Git history is the changelog. Add release tooling when
someone other than the author installs it.

## See also

- [Development](./development.md)
