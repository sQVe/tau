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

| Command                                        | Use                                                                                             |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `pnpm check`                                   | Check the installed Pi minor, then run typechecking, lint, formatting, and the full test suite. |
| `pnpm test:changed`                            | Run tests affected by uncommitted changes. Add `origin/main` to include branch commits.         |
| `pnpm test src/extensions/commit/tool.test.ts` | Run one test file.                                                                              |
| `pnpm test:unit`                               | Skip `*.integration.test.ts` files.                                                             |
| `pnpm test:coverage`                           | Run the full test suite and report coverage.                                                    |
| `pnpm test`                                    | Run the full test suite, including package loading through Pi.                                  |
| `pnpm style:check`                             | Check all lint rules, including house style.                                                    |
| `pnpm style:fix`                               | Apply safe lint fixes, then format.                                                             |
| `pnpm lint`                                    | Run ordinary lint diagnostics, as editors do.                                                   |
| `pnpm format`                                  | Format files.                                                                                   |

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
`bulk_read` and answer-mode `fetch_content`. It uses Pi's credentials and does not change the
session model. Use the exact provider and model ID from `pi --list-models`, including router
prefixes such as `openrouter/anthropic/model-id`. The model needs working credentials. See the
[shared-delegate decision](adr/0027-share-one-delegate-model.md) for why the tasks share one model,
and the [default decision](adr/0044-restore-gpt-5-6-luna-as-the-delegate-default.md) for the
default.

### Workers

The bundled `scout`, `worker`, `reviewer`, and `qa` profiles default to
`claude-bridge/claude-opus-5-5`. Set `TAU_SUBAGENT_MODEL=provider/model-id` to replace that default,
or to choose the model for a user or project profile that names none. A launch `model` overrides
both, and a model in a user or project profile overrides the setting. Without any model, worker
launch refuses; it never falls back to the parent's model. See the
[default decision](adr/0047-default-bundled-worker-profiles-to-opus-5-5.md).

A launch without `timeoutSeconds` gets 30 minutes for investigation profiles and 60 minutes for
editing profiles.

A profile's `tools:` setting lists the tools its worker gets, separated by commas. Without it,
investigation profiles get `read` and `bash`, and editing profiles add `edit` and `write`. Workers
always get `subagent_progress`, `subagent_report`, and `subagent_question`. A worker refuses to
start when a listed tool is not registered. Workers load no skills unless the profile's `skills:`
setting names them, for example `skills: tdd`. See the
[tool and skill decision](adr/0067-give-workers-only-their-profile-tools-and-skills.md).

A profile's `packages:` setting lists Pi packages its worker loads, separated by commas. Each entry
is a source that `pi -e` accepts, such as `npm:name`, `npm:name@1.2.3`, `git:host/path`, a URL, or a
local path. Before it opens the worker's pane, the parent installs each package into Pi's temporary
`-e` cache, and the worker loads it with `-e`. The parent session does not load it. A package that
the user or project settings already load is not loaded a second time. A launch stops with the
package name when an install fails. An unpinned npm package stays at the version that was first
cached, so pin a version to update it. See the
[package decision](adr/0069-load-each-pi-package-where-its-tools-are-used.md).

The bundled `qa` profile sets `packages: npm:pi-agent-browser-native` for its browser tools. If the
parent session does not use the browser itself, remove `npm:pi-agent-browser-native` from the
`packages` list in `~/.pi/agent/settings.json`.

A profile's `instruction-sets:` setting lists the Tau instruction sets its worker loads, from
`writing`, `coding`, and `workflow`. Without it, a worker loads all three. The bundled `scout` and
`qa` profiles set `instruction-sets: writing, workflow`. See the
[instruction set decision](adr/0068-load-only-the-instruction-sets-each-worker-profile-needs.md).

Set `TAU_SUBAGENT_CAP` to limit how many live workers each parent controller runs at once. It takes
an integer from 1 to 256 and defaults to 4. Each controller reads the cap once when it starts. A
launch at the cap refuses and lists the live workers with their deadlines; retry after a stop
notice. Workers cannot launch workers; they ask their parent instead.

### Web provider

Configure a search provider in `~/.pi/agent/web-search.json`, not in this repository. If you already
have the older `~/.pi/web-search.json`, edit that file instead: pi-web-access reads it only when the
first file is missing. Most providers need an API key. To search without a key, select DuckDuckGo
explicitly:

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
renders, that arrow keys and Enter select an option, and that Esc abandons it. In a multi-select
question, check that Space checks options, that typed text checks the "Type something." row, and
that Enter submits from any row.

### Web access

With a search provider configured, ask Pi to search the web. Check that Pi calls `web_enable` first,
that `web_search` returns results, and that `fetch_content` on a URL returns readable markdown.

### Snippets

Press `ctrl+q`, turn on one snippet, and send a message. Check that Pi receives the snippet text
around your message, and that the toggle turns off again.

### Statusbar

Check that the footer stays on one line and shows the directory, branch, cost, context usage, model,
and thinking level. Edit a file through a tool and check that `*` appears beside the branch. Narrow
the terminal and check that the right group truncates before the left.

### Commits

Use a temporary repository.

1. Change a file and call `commit`. Let the tool stage the file. Check that it commits without a
   prompt.
2. Install a `pre-commit` hook that exits with an error and call `commit` again. Check that the hook
   output returns as a tool error without a prompt or a new commit, and that the file is unstaged.

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

## Measuring token use

Report the token use of Pi parent sessions and Tau workers over a time window, for example before
and after a token cut:

```sh
pnpm token-usage --since 3d
```

`--since` and `--until` take an ISO date or time, or an age such as `12h` or `3d`. `--since`
defaults to `7d` and `--until` to now. `--top` sets how many sessions to list, 10 by default.

The report counts only entries timestamped inside the window. It lists tokens by kind and source,
assistant turns by worker profile and model, the top sessions, and tool output characters by tool.
Context means `input + cacheRead + cacheWrite` of one request. The median first request comes from
each session's first request, and the median final context from each task's last request in the
window, or for a parent, from each session's last request. The second line counts skipped records,
so check it before comparing two reports.

Claude and Codex workers write no Pi session, so the report cannot measure their tokens. The second
line counts those that started in the window. A cut looks larger than it is when work moves from Pi
workers to them.

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
