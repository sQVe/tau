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

To try this checkout in Pi without changing global settings:

1. Add the checkout as a project package:

   ```sh
   pnpm exec pi install -l "$PWD" --approve
   ```

2. Open project package settings and set every resource from the previously installed Tau package to
   `-` (unload): its Tau extension, question tool, CC Safety Net, web tools, and skills. Leave
   resources from other inherited packages enabled. If no other inherited Tau package is present,
   there is nothing to unload:

   ```sh
   pnpm exec pi config -l --approve
   ```

3. Start Pi with project resources enabled:

   ```sh
   pnpm exec pi --approve
   ```

The checkout package manifest loads Tau, the question tool, CC Safety Net, the web tools, and the
checkout skills. Unloading every resource from the inherited Tau package prevents duplicate Tau
resources. This checkout and other configured packages stay enabled. Pi writes this project-local
`.pi/settings.json`; keep that file out of commits, and do not add it to global settings.
`--approve` trusts this project's local settings for the run.

Set `TAU_DELEGATE_MODEL=provider/id` before launching Pi to choose the delegate for `bulk_read`,
answer-mode `fetch_content`, and commit comment review. This does not change Pi's session model.
Unset or empty settings use `openai-codex/gpt-5.6-luna`. Tau uses Pi's model registry and
credentials; the reference must match `pi --list-models` exactly, with no whitespace. Model IDs may
contain slashes. For example, prefix the launch command with
`TAU_DELEGATE_MODEL=openrouter/vendor/model` for a model your account can access.
`TAU_BULK_READ_MODEL` has been removed and is ignored.

For web answers, a nonblank per-call `answerModel` wins over the shared setting, then the built-in
default. Tau continues to override `fetch.answerProvider` and `fetch.answerModel` in the web
package's configuration. Other web modes are unchanged.

Per-call overrides also require the exact provider and model reference. Unlike the web package's
standalone behavior, Tau does not infer a router from a native-provider reference. If a model is
available only through OpenRouter, use its full reference, such as `openrouter/anthropic/model-id`,
rather than `anthropic/model-id`. Check the provider and model ID columns in `pi --list-models` for
the exact values.

Invalid references, missing models, and authentication or provider failures return errors rather
than switch to another model or provider. Failed comment review blocks the commit. Bulk-read hard
failures stop read clamping for the session, so ordinary reads remain available. Cancellation,
timeouts, input limits, and length stops do not disable clamping. The
[shared-delegate decision](adr/0027-share-one-delegate-model.md) records the default's comparison.

The package manifest declares all four Tau extension entries. Do not replace it with only
`./src/extensions/index.ts`: that omits the bundled question and web tools, and it omits CC Safety
Net, so worker launch refuses. Do not use `--no-extensions` or `--no-skills` for this checkout
workflow. Those flags suppress configured defaults such as installed skills and herdr integrations.

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

**Bulk read.** With a working delegate, read a file longer than 400 lines without a limit. Check
that the result ends with a `bulk_read` hint instead of `Use offset=`. Ask `bulk_read` a question
using `paths` and `question`, then read a bounded range before editing. Check that the delegate's
usage appears in the session totals. Restart with a missing model reference and check that reads are
not clamped.

## Measuring bulk reads

Repeat this when the delegate or the session model changes; ADR 0014 records what the last run
found. Measure with real providers on a session too small to compact, using one semantic question
spanning three files above the threshold. Compare a local build with trimming off and `bulk_read`
present against the shipped setup, since there is no shipped trimming flag. Run each twice with the
same prompt and files and keep the medians.

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
