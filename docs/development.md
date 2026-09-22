# Development

Set up a checkout, try Tau in Pi, and check changes before release.

## Local setup

Use the Node.js version required by `engines.node` and the pnpm version specified by
`packageManager` in [package.json](../package.json). Run these commands from the Tau checkout:

```sh
pnpm install --frozen-lockfile
pnpm check
```

Pi loads the TypeScript source directly; there is no build step.

## Check changes

| Command                                        | Use                                                                                          |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `pnpm check`                                   | Run typechecking, all lint rules, formatting checks, and the full test suite before pushing. |
| `pnpm test:changed`                            | Run tests affected by uncommitted changes. Add `origin/main` to include branch commits.      |
| `pnpm test src/extensions/commit/tool.test.ts` | Run one test file.                                                                           |
| `pnpm test:unit`                               | Skip `*.integration.test.ts` files.                                                          |
| `pnpm test`                                    | Run the full test suite, including package loading through Pi.                               |
| `pnpm style:check`                             | Check all lint rules, including house style.                                                 |
| `pnpm style:fix`                               | Apply safe lint fixes, then format.                                                          |
| `pnpm lint`                                    | Run ordinary lint diagnostics, as editors do.                                                |
| `pnpm format`                                  | Format files.                                                                                |

Tests use temporary directories and need no model API. Changed-test selection follows imports;
changes to `vite.config.ts` or `package.json` run the full suite.

Style commands accept file paths, for example `pnpm style:fix tests/lint.test.ts`. Rename bindings
and move helpers manually. Staged-file hooks enforce the same rules. Do not set `TAU_LINT_STYLE`
globally; the style commands set it for their child linter.

Configure linting and formatting in [vite.config.ts](../vite.config.ts). Keep the installed Vitest
version the same as the version bundled with Vite+.

## Try Tau

To try this checkout in Pi without changing global settings:

1. Add the checkout as a project package:

   ```sh
   pnpm exec pi install -l "$PWD" --approve
   ```

2. Open project package settings and set every resource from any previously installed Tau package to
   `-` (unload): its Tau extension, question tool, CC Safety Net, web tools, and skills. Leave this
   checkout and other packages enabled. Skip this step if no inherited Tau package is present.

   ```sh
   pnpm exec pi config -l --approve
   ```

3. Start Pi with project resources enabled:

   ```sh
   pnpm exec pi --approve
   ```

Keep the generated `.pi/settings.json` out of commits. `--approve` trusts project-local settings for
the run.

Use the full package manifest, not only `./src/extensions/index.ts`: the latter omits the bundled
question and web tools and CC Safety Net, causing worker launch to refuse. Do not use
`--no-extensions` or `--no-skills`; they suppress configured resources, including skills and herdr
integrations.

Before launching a Pi subagent worker, install herdr's Pi integration in the parent Pi session:

```sh
herdr integration install pi
```

The command writes the integration to `~/.pi/agent/extensions/`, where Pi loads global extensions
automatically. Without the integration, worker launch refuses before it runs any herdr pane command.

For use in another project, run `pi install -l /absolute/path/to/tau` there, then start Pi. This
records the local package in that project's `.pi/settings.json`.

### Delegate model

Set `TAU_DELEGATE_MODEL=provider/model-id` before launching Pi to choose the delegate for
`bulk_read`, answer-mode `fetch_content`, and commit comment review. It uses Pi's credentials and
does not change the session model. Use the exact provider and model ID from `pi --list-models`,
including router prefixes such as `openrouter/anthropic/model-id`. The model needs working
credentials. See the [shared-delegate decision](adr/0027-share-one-delegate-model.md) for the
default and its comparison.

### Web provider

Configure a search provider in `~/.pi/web-search.json`, not in this repository. Most providers need
an API key. To search without a key, select DuckDuckGo explicitly:

```json
{
  "searchProvider": "duckduckgo"
}
```

## Manual check

Tests cover the tools themselves, including committing and blocking raw `git commit`. Check terminal
rendering and live network access manually in a session started as above:

### Questions

Ask Pi something underspecified so it calls `ask_user_question`. Check that the questionnaire
renders, that arrow keys and Enter select an option, and that Esc abandons it.

### Web access

With a search provider configured, ask Pi to search the web. Check that `web_search` returns results
and that `fetch_content` on a URL returns readable markdown.

### Snippets

Press `ctrl+q`, turn on one snippet, and send a message. Check that Pi receives the snippet text
around your message, and that the toggle turns off again.

### Statusbar

Check that the footer stays on one line and shows the directory, branch, cost, context usage, model,
and thinking level. Edit a file through a tool and check that `*` appears beside the branch. Narrow
the terminal and check that the right group truncates before the left.

### Commits

Use a temporary repository. Comment review calls the shared delegate, so that model needs working
credentials.

1. Change a file with an accurate comment and call `commit`. Let the tool stage the file. Check that
   a clean review commits without a prompt.
2. Submit a change with an inaccurate comment. Check that a blocking finding returns a tool error
   without a prompt or a new commit. Correct the comment and call `commit` again.

### Bulk read

With a working delegate, read a file longer than 400 lines without a limit. Check that the result
ends with a `bulk_read` hint instead of `Use offset=`. Ask `bulk_read` a question using `paths` and
`question`, then read a bounded range before editing. Check that the delegate's usage appears in the
session totals. Restart with a missing model reference and check that reads are not clamped.

## Versioning

Add a changeset for user-facing changes:

```sh
pnpm changeset
```

Describe the behavior change for users. Commit the generated file under `.changeset/` with the
change it describes.

The [changeset check](../.github/workflows/changeset.yml) requires a changeset when a PR touches
`src/` or `skills/`, but not for changes only to docs, tooling, or dependencies.

The [release workflow](../.github/workflows/release.yml) opens version PRs and creates Git tags and
GitHub releases; Tau is private and is not published to npm.

## Measuring bulk reads

Repeat this when the delegate or the session model changes;
[ADR 0014](adr/0014-delegate-model-for-bulk-reads.md) records what the last run found. Measure with
real providers on a session too small to compact, using one semantic question spanning three files
above the threshold. Compare a local build with trimming off and `bulk_read` present against the
shipped setup, since there is no shipped trimming flag. Run each twice with the same prompt and
files and keep the medians.

Sum usage by role from the session JSONL. Pi's `/session` can hide per-model rows when catalog cost
is zero or only one model was used:

```sh
jq -rs '[.[] | select(.type=="message") | .message | select(.role=="assistant" or .role=="toolResult")]
  | group_by(.role)[]
  | [.[0].role, (map(.usage.input // 0) | add), (map(.usage.cacheRead // 0) | add), (map(.usage.cacheWrite // 0) | add), (map(.usage.output // 0) | add), (map(.usage.cost.total // 0) | add)]
  | @tsv' session.jsonl
```

It prints one row per role: input, cache read, cache write, output, and cost.

To count how often sessions reach the clamp, run
[scripts/bulk-read-population.sh](../scripts/bulk-read-population.sh) from a clean shell. It reads
`~/.pi/agent/sessions` unless given another directory and prints session count, read calls,
unbounded reads, truncated-or-hinted results, offset pages, `bulk_read` calls, and cost by role.

Record configuration, session input, cache read, cache write, output, delegate input, delegate
output, assistant turns, `offset` pages after a clamped read, wall clock, and catalog cost as a
ratio, not an invoice. Offline faux tests prove usage plumbing and result size, not savings.
