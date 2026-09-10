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

[ADR 0013](./adr/0013-delegate-model-for-bulk-reads.md) was accepted on the measurement below.
Repeat it when the delegate or the session model changes. Measure with real providers on a session
too small to compact. Use one semantic question spanning three files above the threshold. Compare a
local build with trimming off and `bulk_read` present against the shipped setup; there is no shipped
trimming flag. Run each twice with the same prompt and files and keep the medians.

Sum usage by role from the session JSONL. Pi's `/session` can hide per-model rows when catalog cost
is zero or only one model was used:

```sh
jq -r 'select(.type=="message") | .message | select(.role=="assistant" or .role=="toolResult") | [.role, .usage.input, .usage.cacheRead, .usage.cacheWrite, .usage.output, .usage.cost.total] | @tsv' session.jsonl
```

Record configuration, session input, cache read, cache write, output, delegate input, delegate
output, assistant turns, `offset` pages after a clamped read, wall clock, and catalog cost as a
ratio, not an invoice. Offline faux tests prove usage plumbing and result size, not savings.

### Results, 2026-09-10

Session model `openai-codex/gpt-6-astra` at medium thinking, delegate `openai-codex/gpt-5.6-luna`,
Pi 0.85.1 in print mode. Fixture: Pi's `loader.js`, `runner.js`, and `model-resolver.js`, 2,244
lines, with one question about flags, tool-call handlers, and model resolution. Tokens in thousands,
cost in catalog dollars.

| Run             | Session in | Cache read | Out | Delegate in | Delegate out | Turns | Reads                    | Wall | Cost |
| --------------- | ---------- | ---------- | --- | ----------- | ------------ | ----- | ------------------------ | ---- | ---- |
| A1 trimming off | 30.2       | 60.9       | 0.9 | 0           | 0            | 4     | 3 full                   | 40s  | 0.41 |
| A2 trimming off | 23.0       | 30.8       | 1.1 | 0           | 0            | 4     | 6 bounded                | 44s  | 0.32 |
| B1 shipped      | 26.1       | 54.1       | 1.0 | 0           | 0            | 8     | 5 bounded                | 52s  | 0.37 |
| B2 shipped      | 19.9       | 23.8       | 0.9 | 23.6        | 2.2          | 3     | 3 clamped, 1 `bulk_read` | 80s  | 0.28 |
| Median A        | 26.6       | 45.9       | 1.0 | 0           | 0            | 4     |                          | 42s  | 0.36 |
| Median B        | 23.0       | 39.0       | 1.0 | 11.8        | 1.1          | 5.5   |                          | 66s  | 0.32 |

Cost includes the delegate, which was $0.007 in B2. Findings:

- The session model often avoids bulk reads on its own: in A2 and B1 it grepped with bash and read
  bounded ranges, which the clamp leaves alone. Those runs cost the same in either configuration.
- When it does read unbounded, the clamp works as designed. B2 hit three clamped reads, followed the
  hint into one `bulk_read`, and finished in three turns. Against A1, the comparable full-read run,
  that is 32% cheaper and twice as slow. No run paged with `offset` after a clamped read.
- The delegate call took about 50 seconds for a 24k-token payload, longer than Portal's reported 10
  to 30 seconds. Latency, not money, is the cost of delegation with this pair of models.
- Median saving across all four runs is 11%, inside the run-to-run variance. The 400-line threshold
  stays. Code writers do not earn a ticket on this evidence.
- After asking for the fewest bullets, two forced full-read runs saw delegate calls of 26 to 35
  seconds for 800 to 1,250 output tokens, with the session model's final answers unchanged in
  substance. An output cap was tried alongside and removed: Pi's Codex adapter ignores it, and on
  other providers it would throw on a long answer.

### Follow-up experiments, 2026-09-10

Three further changes were each committed, measured live with the same fixture, and reverted. The
criteria came from a review of the first six sessions; every run's citations were checked against
the fixture by a separate agent.

| Change                                                       | Runs                | Result                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Hint offers bounded reads "for exact code", not only to edit | 4 forced, 2 natural | No delegate speedup. Two of five clamped runs skipped delegation for bounded reads; one was the most expensive run measured and had two mis-bounded citations. Reverted.                                                                                                       |
| One delegate call per file, in parallel                      | 6 forced            | Delegate calls 23 to 33 seconds, throughput 73 to 111 tokens per second against 41 to 51. Per-file answers padded a quarter of their words with remarks about files the call did not see, grew longer in total, and one run doubled its calls. Reverted as not worth the code. |
| System-prompt guideline to delegate before whole-file reads  | 4 natural           | Every run delegated first, then read four to six bounded ranges anyway. Session cost down 12%, wall clock up about 40 seconds, and three of four answers dropped a claim the clamp-then-delegate runs kept. Reverted.                                                          |

What held: the clamp and hint, the shorter-answer sentence, and the delegate's default reasoning.
The single delegate call at 26 to 37 seconds is the remaining latency, and it tracks answer length.

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
