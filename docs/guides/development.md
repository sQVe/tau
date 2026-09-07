# Development

Set up a checkout, try Tau in Pi, and verify changes.

## Local setup

Use the Node.js version required by `engines.node` and the pnpm version specified by
`packageManager` in [package.json](../../package.json). Run these commands from the Tau checkout:

```sh
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` runs TypeScript, lint, formatting, and all tests, including package loading through Pi.
Use `pnpm format` to format files. Pi loads the TypeScript source directly; there is no build step.
Tests use temporary directories and need no model API.

For a focused test run, pass a test file to `pnpm test`:

```sh
pnpm test src/extensions/commit/tool.test.ts
```

Run the full `pnpm check` before finishing a change.

## Try Tau

To try Tau in an interactive Pi session from this checkout:

```sh
pnpm exec pi --no-extensions --no-skills -e ./src/extensions/index.ts --skill ./skills/commit
```

For use in another project, run `pi install -l /absolute/path/to/tau` there, then start Pi. This
records the local package in that project's `.pi/settings.json`.

## Manual smoke test

Use a disposable Git repository with Tau installed and a changed file ready to commit.

1. Ask Pi to commit that file through `/commit`. Check that the tool requests confirmation and
   creates one commit after approval.
2. Inspect `git show --stat` to check the committed files.
3. Ask Pi to run raw `git commit` through bash. Check that Tau blocks the call.

## Current status

The commit extension is the only extension. TDD enforcement is not built yet.

## See also

- [Maintenance](./maintenance.md)
