# Development

Set up a checkout, try Tau in Pi, and verify changes.

## Local setup

Use the Node.js version required by `engines.node` and the pnpm version specified by
`packageManager` in [package.json](../package.json). Run these commands from the Tau checkout:

```sh
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` runs TypeScript, lint, formatting, and all tests, including package loading through Pi.
Use `pnpm format` to format files. Pi loads the TypeScript source directly; there is no build step.
Tests use temporary directories and need no model API.

To run one test file, pass its path to `pnpm test`:

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

## Manual check

Use a temporary Git repository with Tau installed and a changed file ready to commit.

1. Ask Pi to commit that file through `/commit`. Check that the tool requests confirmation and
   creates one commit after approval.
2. Inspect `git show --stat` to check the committed files.
3. Ask Pi to run raw `git commit` through bash. Check that Tau blocks the call.

## Current status

Tau includes the commit, TDD, and writing extensions. The commit extension includes
[comment review](./comment-review.md) before approval. Interactive commits need credentials for the
session model; automated tests use a scripted provider and make no model API calls.

TDD edit enforcement is on. The [run_tests tool](../src/extensions/tdd/index.ts) describes the cycle
from a failing test through production edits to full verification, with test evidence persisted to
`.tau/state.json` in the worktree so it survives a restart.

The writing extension adds its [instructions](../src/extensions/writing/instructions.md) to the
system prompt before each ordinary agent run. No skill command is needed. Run `/reload` in Pi after
editing the instructions. Compaction and branch summaries use separate prompts.

## See also

- [Maintenance](./maintenance.md)
