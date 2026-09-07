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
pnpm exec pi --no-extensions --no-skills -e ./src/extensions/index.ts \
  -e ./node_modules/@juicesharp/rpiv-ask-user-question/index.ts --skill ./skills/commit
```

Pass both extension entries. `package.json` declares the same pair, so a checkout that loads only
`./src/extensions/index.ts` is missing the bundled question tool and reports it at session start.

For use in another project, run `pi install -l /absolute/path/to/tau` there, then start Pi. This
records the local package in that project's `.pi/settings.json`.

## Manual check

Use a temporary Git repository with Tau installed and a changed file ready to commit.

1. Ask Pi to commit that file through `/commit`. Check that the tool requests confirmation and
   creates one commit after approval.
2. Inspect `git show --stat` to check the committed files.
3. Ask Pi to run raw `git commit` through bash. Check that Tau blocks the call.
4. Ask Pi something underspecified so it calls `ask_user_question`. Check that the questionnaire
   renders, that arrow keys and Enter select an option, and that Esc abandons it. Automated tests
   cover only that the tool is registered, so the dialog needs a real terminal to verify.
5. Press `ctrl+shift+s`, turn on one snippet, and send a message. Check that Pi receives the snippet
   text around your message, and that the toggle turns off again.

## Current status

Tau includes the commit, writing, snippets, and ask-user-question extensions. The commit extension
includes
[comment review](./comment-review.md) before approval. TDD enforcement is not built yet. Interactive
commits need credentials for the session model; automated tests use a scripted provider and make no
model API calls.

The snippets extension adds [prompt snippets](./prompt-snippets.md) to your message when you send
it. Press `ctrl+shift+s` or run `/snippets` to open the toggle menu. The menu is a terminal
component, so it runs only in the terminal UI. In RPC mode the command reports that and changes
nothing. Print mode has no way to show the message, so the command changes nothing there and stays
silent.

The writing extension adds its [instructions](../src/extensions/writing/instructions.md) to the
system prompt before each ordinary agent run. No skill command is needed. Run `/reload` in Pi after
editing the instructions. Compaction and branch summaries use separate prompts.

If the instructions are missing, unreadable, or blank, Tau fails to load and Pi reports the error. A
missing file in an installed package means the package needs repair or reinstallation.

The ask-user-question extension comes from the bundled
[@juicesharp/rpiv-ask-user-question](https://www.npmjs.com/package/@juicesharp/rpiv-ask-user-question)
package, which `package.json` loads through its own `pi.extensions` entry. Tau checks at session
start that the tool is registered and reports an extension error when it is not. Pi logs that error
and continues the session, so the tool is simply absent until the package is reinstalled.

## See also

- [Maintenance](./maintenance.md)
