# Configuration

Tau reads two JSON files:

- The user file, `~/.pi/agent/tau.json`, applies to every repository. The path starts at Pi's agent
  directory, which is `~/.pi/agent` by default.
- The repository file, `.pi/tau.json`, applies to one repository. Tau reads it only in a project
  that Pi trusts.

Each key below names the file that may set it. Tau fails a key in the wrong file and names the file
that owns it. [ADR 0061](adr/0061-layer-tau-config-from-user-and-repository-files.md) gives the
reasons for these rules.

Tau applies the built-in defaults first. Then it reads the user file, and then the repository file,
for each key that allows both.

- An unknown key warns once per session and Tau ignores it. The warning names the file and key path.
- A wrong type or a missing required field fails the feature that reads it. The error names the file
  and field.
- A bad entry for another repository does not affect the current repository.
- A key that is absent from its file is unset. So is a repository with no entry. Each section says
  what an unset key does.
- A present entry with a missing required field is an error. It is not an unset entry.

Repository entries use an `owner/name` key, such as `sQVe/tau`. Matching ignores case. Two keys that
differ only in case are an error. Features that need the current repository find it from the
`origin` remote. Only an `origin` on `github.com` names a repository. For any other host, Tau finds
no entry, even when the map has the same `owner/name`. Review bots are the exception: they use the
base repository of the pull request.

## TDD hints

Set these keys in either file. Each key you set replaces its default. A list in the repository file
replaces the list in the user file.

- `productionGlobs`: array of glob strings. Default:
  `{src,apps,packages,functions,infra}/**/*.{ts,tsx,js,jsx,mjs,cjs}`.
- `testGlobs`: array of glob strings. Default: `**/*.test.{ts,tsx,js,jsx,mjs,cjs}` and
  `**/*.spec.{ts,tsx,js,jsx,mjs,cjs}`.
- `testSupportGlobs`: array of glob strings. Default: `tests/**/*.{ts,tsx,js,jsx,mjs,cjs}`.
- `excludedGlobs`: array of glob strings. Default:
  `**/{node_modules,.git,dist,build,coverage,.next,.nuxt,.output,.turbo,.cache,generated,__generated__}/**`.
- `verificationArgv`: array of strings with at least one item. The first item must be `vitest`.
  Default: `["vitest", "run", "--reporter=json", "--reporter=default", "--no-color"]`.

Glob entries accept literal segments, `*`, `**`, `?`, comma brace groups such as `{src,scripts}`, a
leading `./`, and numeric ranges such as `{1..3}`. A range may have at most 1000 values. Tau fails
other glob syntax.

```json
{ "tdd": { "productionGlobs": ["{src,scripts}/**/*.ts"] } }
```

## Full check and mutation

### `fullCheck` (user file)

`fullCheck.repositories.<owner/name>.argv` is the command that the `full_check` tool runs. It is a
non-empty array of non-empty strings.

```json
{ "fullCheck": { "repositories": { "sQVe/tau": { "argv": ["pnpm", "check"] } } } }
```

If the current repository has no entry, `full_check` refuses to run and names the key to add. An
entry without `argv` fails the call with the error.

### `mutation` (repository file)

`mutation.argv` is the command that the `mutation_check` tool runs. It has the same format as the
`fullCheck` argv. Tau reads it only in a trusted project, and it fails a `mutation` key in the user
file.

```json
{ "mutation": { "argv": ["pnpm", "exec", "mutation"] } }
```

Without a `mutation` key in the repository file, `mutation_check` refuses to run. In an untrusted
project, Tau ignores the file, so the same refusal applies. A `mutation` object without `argv` fails
the call. A `mutation` key in the user file fails the call.

## Models

### `allowedModels` (either file)

`allowedModels` is an array of `provider/model-id` strings. Without it, Tau allows any model. When
both files set it, the repository list may only remove models from the user list. A repository entry
that adds a model fails. An empty list allows no model.

Tau fails a model outside the list and never falls back to another model.

```json
{ "allowedModels": ["openai-codex/gpt-5.6-luna", "claude-bridge/claude-opus-5-5"] }
```

### Web search

Search providers and the default answer model belong to
[pi-web-access](https://www.npmjs.com/package/pi-web-access). Tau does not set them. Tau checks an
`answerModel` that a `fetch_content` call passes in answer mode against `allowedModels`.

## Workers

### `subagents.capacity` (user file)

`subagents.capacity` is the number of workers that each parent session runs at once. It is an
integer from 1 to 256. The default is 12.

```json
{ "subagents": { "capacity": 8 } }
```

### `profiles` (user file)

`profiles.<name>.model` is the `provider/model-id` for one worker profile. Its name is the profile
name, such as `scout`. `profiles.default.model` applies to every profile without its own entry.
`default` is reserved and cannot name a profile.

A model passed on a launch overrides both keys. A worker launch with none of them fails. Tau fails a
model that Pi does not list, or a model outside `allowedModels`.

```json
{
  "profiles": {
    "default": { "model": "claude-bridge/claude-opus-5-5" },
    "scout": { "model": "openai-codex/gpt-6.1-sol" }
  }
}
```

#### Model routes

`profiles.<name>.route` lets a classifier model choose the worker model for each brief. It takes
these keys:

- `classifier`: `provider/model-id` of the model that chooses a label.
- `question`: non-empty text that the classifier answers.
- `labels`: an object with exactly two labels. Each label name maps to:
  - `criterion`: non-empty text that says when the label fits.
  - `model`: `provider/model-id` that runs when the label is chosen.
- `confidence`: number from 0 to 1. This is the lowest confidence that keeps the chosen label. The
  default is 0.7.

`profiles.<name>.model` still applies. Tau runs it when the classifier gives no usable answer, when
the answer is below `confidence`, or when `allowedModels` excludes the classifier. Tau does not
refuse the launch in those cases. A label's `model` outside `allowedModels` fails the launch.

Without `route`, the profile runs on `model` alone. A route that fails these rules turns routing off
for its profile and shows an error. The profile model still runs. Use `route`, not `routes`. A
`routes` key is the same case: routing is off, and the error names `route`.

```json
{
  "profiles": {
    "scout": {
      "model": "claude-bridge/claude-opus-5-5",
      "route": {
        "classifier": "my-provider/my-classifier",
        "question": "How wide is this scout brief?",
        "labels": {
          "narrow": {
            "criterion": "A lookup about known code.",
            "model": "claude-bridge/claude-haiku-5-5"
          },
          "wide": {
            "criterion": "An investigation across many files.",
            "model": "claude-bridge/claude-opus-5-5"
          }
        }
      }
    }
  }
}
```

### Profile files

A profile is a Markdown file. Its frontmatter is the block of `key: value` lines between two `---`
lines at the top of the file. The text after the frontmatter gives the worker its instructions. The
text must not be empty.

Tau reads profiles from these folders, in this order:

1. The bundled profiles.
2. `~/.pi/agent/agents/*.md`.
3. `.pi/agents/*.md` in a trusted project.

A later file with the same name replaces an earlier one. The name is the `name` key, or the file
name without `.md`.

Frontmatter keys:

- `name`: optional. Default: the file name without `.md`.
- `description`: optional. Text that shows in the profile list.
- `role`: required. `investigation` gives the tools `read` and `bash`. `editing` gives `read`,
  `bash`, `edit`, and `write`.
- `thinking`: optional. One of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.
  Default: `medium`.
- `cli`: optional. Only `pi` is allowed, and it is the default.
- `tools`: optional. Comma-separated tool names, such as `read, bash`. Replaces the tools of the
  role.
- `skills`: optional. Comma-separated skill names, such as `tdd`. Default: none.
- `instruction-sets`: optional. Comma-separated names from `writing`, `coding`, `workflow`, and
  `browser`. Default: `writing, coding, workflow`.
- `packages`: optional. Comma-separated Pi package sources that `pi -e` accepts, such as `npm:name`,
  `git:host/path`, a URL, or a local path. Default: none.

A profile file must not set `model:`. Set the model in `profiles` in the user file. A key that Tau
does not list, or a repeated key, fails the profile.

```md
---
role: investigation
description: Finds where the code handles a feature.
---

Find the files that handle the brief, and cite the lines you read.
```

The bundled `browser` and `qa` profiles load `npm:pi-agent-browser-native` for their browser tools.
Its `agent_browser_code` tool needs Node on `PATH` when Pi runs as the compiled binary. If the
parent session does not use the browser itself, remove `npm:pi-agent-browser-native` from the
`packages` list in `~/.pi/agent/settings.json`, because the workers load it on their own.

### `browser.loginCommand` (user file)

`browser.loginCommand` is the non-empty command that the manager gives you when a browser worker
needs a login. It names the command that opens the browser package's Chrome profile.

```json
{ "browser": { "loginCommand": "google-chrome-stable --profile-directory=\"Agent profile\"" } }
```

If `browser.loginCommand` is unset, the manager's guidelines leave out the command, and Tau shows no
error. An empty or non-string value shows an error, and the command is left out the same way.

## QA (`qa`, user file)

`qa.repositories.<owner/name>` holds settings for `qa` workers in that repository. Each key is
optional:

- `urlCommand`: non-empty string. When a `qa` launch gives no `url`, Tau runs this command in the
  worker's worktree. Its output must be one http or https URL. The launch fails if the command
  fails, times out, or prints no such URL.
- `testAccountCommand`: non-empty string. The brief tells the worker to run it to read the test
  account. Tau never runs it.
- `dataWrites`: `true` or `false`. Default: `false`. It tells the worker whether it may write to the
  dev database.

```json
{ "qa": { "repositories": { "sQVe/cape": { "urlCommand": "./scripts/dev-url" } } } }
```

## Code reviews (`reviews`, user file)

`reviews.repositories.<owner/name>.bots` lists the bots that Tau asks to review a pull request. The
key is the base repository of the pull request. The list may be empty. Each bot is an object with
two non-empty strings:

- `login`: the bot's GitHub login. Matching ignores case and a trailing `[bot]`.
- `comment`: the exact text of the comment that requests a review.

Two bots with the same login fail.

```json
{
  "reviews": {
    "repositories": {
      "sQVe/tau": { "bots": [{ "login": "chatgpt-codex-connector", "comment": "@codex review" }] }
    }
  }
}
```

Without a `reviews` key, or with no entry for the base repository, Tau requests no bot. An entry
with `bots: []` does the same. An entry without a `bots` list fails the call. So does a bot without
a non-empty `login` or `comment`.

## Tracker (`tracker`, user file)

- `agentTeam`: a Linear team key, such as `AI`. The `tracker` skill sends agent tickets to this
  team. A team key has no spaces. Tau stores it in uppercase.
- `repositories.<owner/name>.team`: required. The Linear team key for other tickets from that
  repository.
- `repositories.<owner/name>.project`: optional. A non-empty Linear project name.

```json
{
  "tracker": {
    "agentTeam": "AI",
    "repositories": { "sQVe/tau": { "team": "ME", "project": "Tau" } }
  }
}
```

Without a `tracker` key, Tau adds no setup line to the session prompt. With a `tracker` key, the
prompt reports each setting:

- No `agentTeam`: the prompt says `tracker.agentTeam is not set.`
- No entry for the current repository: the prompt says `tracker.repositories` has no entry for it.
- An entry without `team`: the prompt shows only a setup error that names the field. The entry gives
  no route.
- An entry without `project`: the route has no project.

## Removed settings

These settings no longer work. Set the replacement instead:

- The `TAU_SUBAGENT_CAP` environment variable. Tau no longer reads it. Set `subagents.capacity`.
- A top-level `slice` key. Tau fails on it. Set `tracker.agentTeam` and `tracker.repositories`.
- `profiles.<name>.routes`. Rename it to `route`.
