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

Set `TAU_BULK_READ_MODEL=provider/id` before launching Pi to choose the bulk-read delegate. It
defaults to `openai-codex/gpt-5.6-luna` and uses Pi's model registry and credentials. For example,
prefix the launch command with `TAU_BULK_READ_MODEL=openrouter/vendor/model` for a model your
account can access. The reference must match `pi --list-models` exactly.

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
the terminal and check that the right group truncates before the left. Run `/tdd off`, then call a
tool and check that the ochre open-lock glyph appears after the branch. Run `/tdd on`, then call a
tool and check that the glyph disappears.

### Commits

Configure credentials for the session model; comment review makes a model API call. Stage a change
that touches a comment and call `commit`. Check that the approval overlay renders and that the
comment review report scrolls.

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

Measure the population across `~/.pi/agent/sessions/**/*.jsonl` from a clean shell:

```sh
env -i HOME="$HOME" PATH="$PATH" bash -c '
set -euo pipefail
find "$HOME/.pi/agent/sessions" -type f -name "*.jsonl" -print0 |
  while IFS= read -r -d "" session; do
    jq -rs '\''
      [.[] | select(.type == "message") | .message] as $messages
      | [$messages[] | select(.role == "assistant") | .content[]?
          | select(.type == "toolCall")] as $calls
      | (reduce ($messages[] | select(.role == "toolResult")) as $result
          ({}; .[$result.toolCallId] = $result)) as $results
      | [$calls[] | select(.name == "read")] as $reads
      | [$calls[] | select(.name == "bulk_read")] as $bulk
      | def cost($role):
          [$messages[] | select(.role == $role) | .usage.cost.total // 0] | add // 0;
        def continued:
          test("\\n\\n\\[[^\\n]*Use offset=[0-9]+ to continue\\.\\]$") or
          test("\\n\\nFile continues at line [0-9]+\\.");
        [1, ($reads | length),
         ([$reads[] | select(.arguments.limit == null)] | length),
         ([$reads[] | $results[.id] | [.content[]? | select(.type == "text") | .text]
           | join("\n") | select(continued)] | length),
         ([$reads[] | select((.arguments.offset // 0) > 1)] | length),
         ($bulk | length), cost("assistant"), cost("toolResult"),
         (if ($bulk | length) > 0 then 1 else 0 end),
         ([$bulk[] | $results[.id].usage.cost.total // 0] | add // 0),
         (if ($bulk | length) > 0 then cost("assistant") else 0 end)]
      | @tsv
    '\'' "$session"
  done |
  awk '\''
    { for (column = 1; column <= NF; column++) totals[column] += $column }
    END {
      printf "Sessions: %d\nread calls: %d\nUnbounded reads: %d\n", totals[1], totals[2], totals[3]
      printf "Truncated or hinted: %d (%.1f%%)\n", totals[4], totals[2] ? 100 * totals[4] / totals[2] : 0
      printf "Offset pages (upper bound): %d\nbulk_read calls: %d\n", totals[5], totals[6]
      printf "Cost by role: assistant $%.2f; toolResult $%.2f\n", totals[7], totals[8]
      printf "Sessions using bulk_read: %d\n", totals[9]
      printf "bulk_read cost: $%.2f; assistant cost in those sessions: $%.2f\n", totals[10], totals[11]
    }
  '\''
'
```

The query joins calls and results by `toolCallId` within each file and totals catalog cost by role.
Sessions before `bulk_read` shipped are counted; files under 400 lines count as unbounded reads; the
offset count is an upper bound without a same-path join.

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
