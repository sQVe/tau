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
  -e ./node_modules/@juicesharp/rpiv-ask-user-question/index.ts \
  -e ./node_modules/pi-web-access/index.ts --skill ./skills/commit
```

Pass all three extension entries. `package.json` declares the same set, so a checkout that loads
only `./src/extensions/index.ts` is missing the bundled question and web tools and reports it at
session start.

For use in another project, run `pi install -l /absolute/path/to/tau` there, then start Pi. This
records the local package in that project's `.pi/settings.json`.

## Manual check

Tests cover the tools themselves, including committing and blocking raw `git commit`. What they
cannot reach is terminal rendering and the live network. In a session started as above:

**Questions.** Ask Pi something underspecified so it calls `ask_user_question`. Check that the
questionnaire renders, that arrow keys and Enter select an option, and that Esc abandons it.

**Web access.** With a search provider configured, ask Pi to search the web. Check that `web_search`
returns results and that `fetch_content` on a URL returns readable markdown.

**Snippets.** Press `ctrl+q`, turn on one snippet, and send a message. Check that Pi receives the
snippet text around your message, and that the toggle turns off again.

## Current status

Tau includes the commit, TDD, writing, snippets, ask-user-question, and web-access extensions. The
commit extension includes [comment review](./comment-review.md) before approval. Interactive commits
need credentials for the session model; automated tests use a scripted provider and make no model
API calls.

TDD edit enforcement is on. The [run_tests tool](../src/extensions/tdd/index.ts) describes the cycle
from a failing test through production edits to full verification, with test evidence persisted to
`.tau/state.json` in the worktree so it survives a restart. Only files matching the production globs
are gated, and the gate is off with a notice when no test runner resolves from the worktree.

`/tdd off` turns the gate off for the worktree and records the time in `.tau/state.json`, so it
survives a restart; `/tdd on` turns it back on and `/tdd status` reports the gate, the phase, and
whether production writes are allowed. While the gate is off, protected paths stay blocked. A
successful write carries no notice because the guard can only allow or block a call, so the notice
appears on `run_tests` and `commit` results. Recorded evidence is left untouched.

The snippets extension adds [prompt snippets](./prompt-snippets.md) to your message when you send
it. Press `ctrl+q` or run `/snippets` to open the toggle menu. The menu is a terminal component, so
it runs only in the terminal UI. In RPC mode the command reports that and changes nothing. Print
mode has no way to show the message, so the command changes nothing there and stays silent.

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

The web-access extension comes from the bundled
[pi-web-access](https://www.npmjs.com/package/pi-web-access) package, loaded through its own
`pi.extensions` entry. It provides `web_search` and `fetch_content`, and Tau checks at session start
that both are registered.

Search providers are configured per user in `~/.pi/web-search.json`, not in this repository, so Tau
ships no configuration for it. Most providers need an API key. DuckDuckGo is keyless but
explicit-only: the package never picks it automatically. To search without any key, make it the
default:

```json
{
  "searchProvider": "duckduckgo"
}
```

The path follows `XDG_CONFIG_HOME` (`$XDG_CONFIG_HOME/pi/web-search.json`) or `PI_CODING_AGENT_DIR`
when either is set.

## See also

- [Maintenance](./maintenance.md)
