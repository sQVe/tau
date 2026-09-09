# Development

Set up a checkout, try Tau in Pi, and check changes before release.

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

Configure linting and formatting in [vite.config.ts](../vite.config.ts). Keep the installed Vitest
version the same as the version bundled with Vite+.

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

Web search needs a provider, configured per user in `~/.pi/web-search.json` and not in this
repository. Most providers need an API key. DuckDuckGo is keyless, but the package never picks it
automatically, so name it as the default to search without a key:

```json
{
  "searchProvider": "duckduckgo"
}
```

`PI_CODING_AGENT_DIR` overrides that directory and is used verbatim, with no `pi` segment. Otherwise
`XDG_CONFIG_HOME` selects `$XDG_CONFIG_HOME/pi/web-search.json`, except that an existing
`~/.pi/web-search.json` still wins when the XDG copy is absent.

## Manual check

Tests cover the tools themselves, including committing and blocking raw `git commit`. What they
cannot reach is terminal rendering and the live network. In a session started as above:

**Questions.** Ask Pi something underspecified so it calls `ask_user_question`. Check that the
questionnaire renders, that arrow keys and Enter select an option, and that Esc abandons it.

**Web access.** With a search provider configured, ask Pi to search the web. Check that `web_search`
returns results and that `fetch_content` on a URL returns readable markdown.

**Snippets.** Press `ctrl+q`, turn on one snippet, and send a message. Check that Pi receives the
snippet text around your message, and that the toggle turns off again.

**Statusbar.** Check that the footer stays on one line and shows the directory, branch, cost,
context usage, model, and thinking level. Edit a file through a tool and check that `*` appears
beside the branch. Narrow the terminal and check that the right group truncates before the left. Run
`/tdd off`, then call a tool and check that the ochre open-lock glyph appears after the branch. Run
`/tdd on`, then call a tool and check that the glyph disappears.

**Commits.** Configure credentials for the session model; comment review makes a model API call.
Stage a change that touches a comment and call `commit`. Check that the approval overlay renders and
that the comment review report scrolls.

## Versioning

Add a changeset for user-facing changes:

```sh
pnpm changeset
```

Describe the behavior change for users. Commit the generated file under `.changeset/` with the
change it describes.

The [changeset check](../.github/workflows/changeset.yml) requires a changeset when a PR touches
`src/` or `skills/`. Changes only to docs, tooling, or dependencies do not trigger that check.

The [release workflow](../.github/workflows/release.yml) opens version PRs and is configured to
create Git tags and GitHub releases after versioning. Tau is private and is not published to npm.
See [package scripts](../package.json) and [Changesets configuration](../.changeset/config.json) for
the release commands and settings.
