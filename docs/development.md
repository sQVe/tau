# Development

Set up a checkout, try Tau in Pi, and check changes before release.

## Local setup

Install [mise](https://mise.jdx.dev/getting-started.html), which installs the pinned stomme binary.
Use Node.js 24.21.0 or later and the pnpm version specified by `packageManager` in
[package.json](../package.json). Development needs a newer Node.js than `engines.node` because
`@sqve/stomme-ts-style` requires 24.21.0. Run these commands from the Tau checkout:

```sh
mise trust
mise install
pnpm install --frozen-lockfile
pnpm check
```

`pnpm install` runs the build that lets Pi load Tau quickly. It writes one generated bundle under
the ignored `dist/tau/` folder, named after a hash of the package inputs, and Pi loads that bundle
only while its hash still matches the sources. An edited source tree, or an install that skipped
scripts, falls back to the TypeScript source. Run `pnpm build:tau` after an edit to refresh the
bundle; `pnpm check` builds it before the tests. The build takes a module only when its suffix is
`.ts`, `.mts`, `.js`, `.mjs`, or `.json`, because the hash covers only those; any other suffix fails
the build. See
[ADR 0146](./adr/0146-load-one-generated-tau-bundle-that-matches-the-package-inputs.md).

## Check changes

| Command                                        | Use                                                                                                                                                                     |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check`                                   | Check the installed Pi minor, run typechecking, lint, formatting, and knip together, build the Pi bundle, then run test projects. Unchanged projects replay from cache. |
| `pnpm build:tau`                               | Build the Pi bundle under `dist/tau/` for the current sources.                                                                                                          |
| `pnpm test:changed`                            | Run tests affected by uncommitted changes. Add `origin/main` to include branch commits.                                                                                 |
| `pnpm test src/extensions/commit/tool.test.ts` | Run one test file.                                                                                                                                                      |
| `pnpm test:unit`                               | Skip `*.integration.test.ts` files.                                                                                                                                     |
| `pnpm test:coverage`                           | Run the full test suite and report coverage.                                                                                                                            |
| `pnpm test`                                    | Run the full test suite without the cache, including package loading through Pi.                                                                                        |
| `pnpm style:check`                             | Check all lint rules, including house style.                                                                                                                            |
| `pnpm style:fix`                               | Apply safe lint fixes, then format.                                                                                                                                     |
| `pnpm check:static:stomme`                     | Check the shared stomme rules.                                                                                                                                          |
| `pnpm lint`                                    | Run ordinary lint diagnostics, as editors do.                                                                                                                           |
| `pnpm format`                                  | Format files.                                                                                                                                                           |

Tests use temporary directories and need no model API. Changed-test selection follows imports;
changes to `vite.config.ts` or `package.json` run the full suite.

Style commands run `stomme-ts-style` and accept file paths, for example
`pnpm style:fix tests/lint.test.ts`. Rename bindings and move helpers manually. Staged-file hooks
enforce the same rules. After a change to the stomme layer, language, or pin, run
`mise exec -- stomme sync`.

`TAU_PROPERTY_SEED` sets the seed of a generated order test. Unset, the test uses its fixed seed, as
`pnpm check` needs. `random` picks a seed and prints it, and an integer replays one:

```sh
TAU_PROPERTY_SEED=random pnpm vitest run src/extensions/subagents/workerDeliveryOrdering.test.ts
```

stomme-ts-style provides the shared lint and format settings. Configure Tau's own settings in
[vite.config.ts](../vite.config.ts), and Tau's own lint rules in
[lint/plugin.ts](../lint/plugin.ts). Keep the installed Vitest version the same as the version
bundled with Vite+.

## Check test strength

Run these by hand from the repository root. Neither is part of `pnpm check`.

```sh
pnpm mutation changed <base>
pnpm mutation audit <path>...
```

`changed` mutation-tests the production lines changed since `<base>`. `audit` mutation-tests whole
files. Both run the [`@sqve/mutation`](https://www.npmjs.com/package/@sqve/mutation) package, which
runs [StrykerJS](https://stryker-mutator.io) with the root `stryker.config.json` and prints a JSON
report. The package README lists the report and the exit codes.

The package always adds the `tauMessageIgnorer` ignorer to the config's `ignorers`. It sets
`ignoreStatic: true` unless the config sets its own value. It sets no mutant cap and no timeout.
Tau's config sets what is particular to this repository: the `mutate` globs, the left-out modules,
`timeoutMS`, the Vitest runner with related tests, and the concurrency. Bump the pinned package
version to get a fix.

The `Mutation` CI job runs `changed` against the pull request's base. Exit 0 and exit 2 pass the
job. Exit 2 means a mutant survived on a changed line, and the job writes each survivor with its
file and line to the job summary as advice. Any other exit fails the job, such as exit 1 for an
error, a file over the mutant cap that the report lists in `unmutated`, or changed files that no
test imports. The job is not a required status check. Where a survivor shows a weak test, add a test
that fails when that line changes.

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

Use the full package manifest, not only `./src/tau.ts`: the latter omits the bundled question and
web tools and CC Safety Net, causing worker launch to refuse. Do not use `--no-extensions` or
`--no-skills`; they suppress configured resources, including skills.

Before launching a Pi subagent worker, run step 3 in a terminal of the `herdr-app` window. Each app
terminal is an `hc` terminal: `hc` sets `HC_TERMINAL_ID` there, and worker launch uses it to find
the manager terminal. Outside an `hc` terminal, worker launch refuses.

For use in another project, run `pi install -l /absolute/path/to/tau` there, then start Pi. This
records the local package in that project's `.pi/settings.json`.

To install a released version instead of a checkout, name its tag:

```sh
pi install git:github.com/sqve/tau@v1.0.0
```

Set models, workers, and other settings in the [configuration reference](configuration.md).

## Manual check

Tests cover the tools themselves, including committing and blocking raw `git commit`. Check terminal
rendering and live network access manually in a session started as above:

### Questions

Ask Pi something underspecified so it calls `ask_user_question`. Check that the questionnaire
renders the problem and the impact, that arrow keys and Enter select an option, and that Esc
abandons it. Ask Pi to recommend an option that is not the first, and check that the questionnaire
opens on it. In a multi-select question, check that Space checks options, that typed text checks the
"Type something." row, and that Enter submits from any row. When a preview is clipped, check that
Ctrl+O shows it in full, that the arrow keys scroll it, and that Esc returns to the options without
closing the questionnaire.

### Web access

With a search provider configured, ask Pi to search the web. Check that Pi calls `web_enable` first,
that `web_search` returns results, and that `fetch_content` on a URL returns readable markdown.

### Worker codemode

Launch a `scout` worker whose task is to report the names of its tools. Check that the list includes
`codemode`. Launch a `qa` worker with the same task. Check that its list does not include
`codemode`.

### Snippets

Type `#push` in the editor and check that the list offers `#push-back` and that the text of
`push-back` shows above the editor. Type `#` alone, press the down arrow, and check that the preview
follows the selection. Press Escape and check that the preview disappears. Type `#push` again, press
Tab, and check that the preview disappears and the editor shows the snippet text in place of
`#push`. Send the message and check that Pi receives the editor text unchanged. Press the up arrow
and check that the editor shows the same text. Run `/reload`, press the up arrow twice, and check
that the message appears once.

### Statusbar

Check that the footer stays on one line and shows only the cost, context usage, model, and thinking
level. Check that a second line shows extension statuses when any is set, and that it is absent when
none is set. Run a tool and check that the cost and context usage update after its result. Narrow
the terminal and check that the line truncates to its width.

### Commits

Use a temporary repository.

1. Change a file and call `commit`. Let the tool stage the file. Check that it commits without a
   prompt.
2. Install a `pre-commit` hook that exits with an error and call `commit` again. Check that the hook
   output returns as a tool error without a prompt or a new commit, and that the file is unstaged.

## Smoke test in Pi

Run the smoke test before each release and after each Pi upgrade. Tests run under Node, but Pi runs
Tau under its own Bun runtime. The smoke test needs the installed `pi`, a model, and credentials for
it.

```sh
pnpm smoke:pi [--pi <binary>] [--tau <checkout>] [--model <pattern>]
```

`--pi` defaults to `pi` on `PATH`. `--tau` defaults to this checkout. `--model` is passed to Pi. The
command prints the path of the saved event log. On failure it prints one line per failed check and
keeps the scratch repository.

### Test one change in a Pi session

To check how a change behaves inside a Pi session, run one headless session that loads this
checkout:

```sh
pnpm pi-session --cwd <directory> (--prompt <text> | --prompt-file <file>) [--model <pattern>] [--timeout <seconds>]
```

Give `--cwd` a scratch directory, not a worktree. The command sends the prompt, waits until each
worker that the session launched has reported or ended, and prints the path of the saved event log.
It exits with code 1 and a `FAIL` line when the session fails or passes the timeout. A worker launch
needs an `hc` terminal, as in [Try Tau](#try-tau). The [QA guide](../.pi/qa.md) holds the feature
files at `.pi/qa/features/<name>.md` and the `jq` checks of the event log.

## Versioning

Add a changeset for user-facing changes:

```sh
pnpm changeset
```

Describe the behavior change for users. Commit the generated file under `.changeset/` with the
change it describes.

The [changeset check](../.github/workflows/changeset.yml) requires a changeset when a PR touches
`src/`, but not for changes only to docs, tooling, or dependencies.

The [release workflow](../.github/workflows/release.yml) opens version PRs and creates Git tags and
GitHub releases; run the [smoke test in Pi](#smoke-test-in-pi) before you merge a version PR. Tau is
private and is not published to npm.

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

The tokens of a worker session still count when its own directory has no readable record. The report
ends with a list of these session files, and the `unreadable` count includes them.

Claude and Codex workers write no Pi session, so the report cannot measure their tokens. The second
line counts those that started in the window. A cut looks larger than it is when work moves from Pi
workers to them.

## Checking Tau health in session logs

Report tool calls, error rates, top errors, and health rules per tool and UTC day, from Pi manager
sessions, worker sessions, and the calls of codemode scripts:

```sh
pnpm session-health --since 2026-09-28 --until 2026-10-07
```

`--since` and `--until` take the same values as in `pnpm token-usage`. `--since` defaults to `7d`.
The report lists failed rules first, then one table per day.

Add a health rule as one entry in [scripts/sessionHealthRules.ts](../scripts/sessionHealthRules.ts).
A rule names its tool and checks the calls of one day. It runs on every day with any logged tool
call, also when its own tool has none that day.

## Scoring question judges

Judge the user's past eligible questions with the classifier and the panel, each with and without
past examples:

```sh
pnpm question-gate-score --limit 20
```

`--since` and `--until` take the same values as in `pnpm token-usage` and default to all logs.
`--limit` takes whole sessions, newest first, until it reaches that many questions, and defaults
to 500. `--holdout` is the share of sessions kept for the held-out check and defaults to 0.3.

The script reads `questionGate` from the user `tau.json` and makes eight model calls per question.
It retries a panel call that fails with a transient provider error, as the user `retry` settings
allow. It prints decide share and agreement at cutoffs from 0.50 to 1.00 on tuning sessions, the
lowest cutoff that reaches 95% agreement, and that cutoff's result on held-out sessions. At the end
it prints each panel model's error count and first error message on stderr. It explores only and
sets no launch cutoff. The logs lack question kind and full context, and older logs cannot tell a
click from typed text equal to an option label.

## Evaluating agent behavior

Use this procedure to test whether a prompt or skill change improves how models behave. CI never
runs model trials. A trial that costs money needs the user's approval and a budget before the first
run. A check of one slice with `pnpm pi-session` is not a trial and needs no budget approval.

1. Fix the tasks, the rubric, the model settings, and the trial budget before the first run.
2. Hold the model constant, so model and prompt effects stay separate.
3. Give each candidate a neutral label and the user prompt as written. Hide the rubric from
   candidates.
4. Check objective criteria first. Then use one blinded judge that sees only the labels.
5. Grade from artifacts and tool transcripts, never from a candidate's own report.
6. Record the model, its settings, and the Pi version with every result. Repeat each prompt within
   the trial budget. There is no fixed minimum run count.
7. Report every run and its cost. Keep inconclusive results.

Write four kinds of case:

- The skill fires when it should.
- The skill stays quiet when it should not fire.
- The skill holds under pressure, such as time pressure or an authority's say-so.
- The skill behaves correctly on a fixture.

Measure routing apart from behavior. Tau routes every skill by its description. For a change to a
skill description, count on real prompts how often the skill fires, and how often it fires when it
must not.

For a case about repository behavior, build a temporary Git repository with the setup committed. Add
an uncommitted patch on top when the case needs one. A dialogue-only case needs no fixture.
