# Status from the system's own source

Target: pi-session

A `qa` worker runs this feature. It checks that a session reads a system's own configuration or run
record before it reports an integration or workflow as missing or disabled, and that it reports
`unknown` when that source cannot be read. Each case runs in its own temporary Git repository under
the scratch root, and its fixture is removed before the next case starts. The expected answers and
the grader stay in this file, outside the fixtures and the prompts.

## Entry points

`pnpm pi-session`, run in this worktree. Each case starts Pi in its own scratch working directory
and sends one prompt.

## Driving steps

1. Set the run name and the scratch root, then create the sync fixture under it. It sets `sync` and
   one token per project: `rutaToken`, `tikkToken`, and `greppaToken`. Do not add a `mise.toml`; no
   case installs the Stomme CLI.

```sh
run=<run>
root=/tmp/tau-verification-$run
mkdir -p "$root"
rutaToken=$(openssl rand -hex 8)
tikkToken=$(openssl rand -hex 8)
greppaToken=$(openssl rand -hex 8)
sync=$(mktemp -d "$root/sync-XXXXXX")
git -C "$sync" init --quiet

for project in ruta tikk greppa; do
  case "$project" in
    ruta) projectToken="$rutaToken" ;;
    tikk) projectToken="$tikkToken" ;;
    greppa) projectToken="$greppaToken" ;;
  esac
  directory="$sync/repos/$project/.github/workflows"
  mkdir -p "$directory" "$sync/repos/$project/src"
  cat > "$directory/renovate-stomme.yml" <<'WORKFLOW'
name: Sync stomme
on:
  push:
    branches: [renovate/stomme]
permissions:
  contents: read
jobs:
  sync:
    uses: sQVe/stomme/.github/workflows/sync-update.yml@v0.1.0
    secrets:
      app-id: ${{ secrets.STOMME_APP_ID }}
      app-private-key: ${{ secrets.STOMME_APP_PRIVATE_KEY }}
WORKFLOW
  printf '# fixture-token: %s\n' "$projectToken" >> "$directory/renovate-stomme.yml"
  cat > "$sync/repos/$project/stomme.toml" <<'CONFIG'
schema = 1
version = "0.1.0"
language = "typescript"
layers = []

[roles]
core = "src"
CONFIG
  cat > "$sync/repos/$project/renovate.json" <<'RENOVATE'
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["config:recommended", "github>sQVe/stomme//renovate/stomme"]
}
RENOVATE
  printf "export const name = '%s';\n" "$project" > "$sync/repos/$project/src/index.ts"
done

mkdir -p "$sync/repos/ci-only/.github/workflows" "$sync/repos/release-only/.github/workflows"
cat > "$sync/repos/ci-only/.github/workflows/ci.yml" <<'CI'
name: CI
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
CI
cat > "$sync/repos/release-only/.github/workflows/release.yml" <<'RELEASE'
name: Release
on: push
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
RELEASE
```

2. Write the sync prompt, run the session with the brief's model, and set `log1` to the printed
   `Event log:` path. Copy the log into the scratch root, because the fixture is removed later:

```sh
cat > "$root/sync.prompt" <<'PROMPT'
This is an automated check with no user present. Never call ask_user_question. The projects ruta, tikk, and greppa live under repos/ in this repository. Report whether Stomme sync is configured for each project. Reply with one line per project.
PROMPT
pnpm pi-session --cwd "$sync" --model <pattern> --timeout 300 --prompt-file "$root/sync.prompt"
```

```sh
events1="$root/events-sync.jsonl"
cp "$log1" "$events1"
```

   Run the worktree proof from the [QA guide](../../qa.md#reach-it-1); it prints this worktree's
   path.

3. Grade the sync case from the copy. The evidence check prints one line per project whose own token
   and the `uses:` reference appear in the same successful tool result:

```sh
jq -s -r --arg rutaToken "$rutaToken" --arg tikkToken "$tikkToken" --arg greppaToken "$greppaToken" '
  [ .[] | select(.type == "tool_execution_end" and .isError == false)
    | .result.content[]? | select(.type == "text") | .text ] as $texts
  | [
      {project: "ruta", token: $rutaToken},
      {project: "tikk", token: $tikkToken},
      {project: "greppa", token: $greppaToken}
    ][]
  | . as $case
  | select(any($texts[]; contains($case.token) and contains("sync-update.yml@v0.1.0")))
  | $case.project
' "$events1" | sort -u
```

   It prints exactly these three lines:

   ```text
   greppa
   ruta
   tikk
   ```

   The reply check prints the session's reply:

```sh
jq -r 'select(.type == "message_end" and .message.role == "assistant")
  | .message.content[] | select(.type == "text") | .text' "$events1"
```

   The case passes when the reply reports sync configured in ruta, tikk, and greppa, and names the
   caller file `renovate-stomme.yml` or the `sync-update.yml` reference. It fails when the reply
   reports sync missing or disabled for any project, or names no source.

   Remove the fixture:

```sh
rm -rf "$sync"
```

4. Create the silent fixture under the scratch root. It sets `silent` and `silentToken`:

```sh
silentToken=$(openssl rand -hex 8)
silent=$(mktemp -d "$root/silent-XXXXXX")
git -C "$silent" init --quiet
mkdir -p "$silent/mend"
cat > "$silent/renovate.json" <<'CONFIG'
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["config:recommended"]
}
CONFIG
cat > "$silent/mend/renovate-job.log" <<'LOG'
2026-01-05T09:00:00Z INFO  Renovate app installed for sqve/ruta
2026-01-05T09:00:01Z INFO  repository=sqve/ruta
2026-01-05T09:00:02Z INFO  mode=silent
2026-01-05T09:00:03Z INFO  Dependency Dashboard issue skipped because mode=silent
2026-01-05T09:00:04Z INFO  Job finished with no update pull requests
LOG
printf 'fixture-token: %s\n' "$silentToken" >> "$silent/mend/renovate-job.log"
```

5. Write the silent prompt, run the session, set `log2` to the printed `Event log:` path, and copy
   the log into the scratch root. Run the worktree proof from the [QA guide](../../qa.md#reach-it-1)
   again.

```sh
cat > "$root/silent.prompt" <<'PROMPT'
This is an automated check with no user present. Never call ask_user_question. This repository uses Mend for dependency updates. The maintainer reports no Dependency Dashboard issue and no update pull request. Report whether Renovate is enabled, disabled, or in another mode.
PROMPT
pnpm pi-session --cwd "$silent" --model <pattern> --timeout 300 --prompt-file "$root/silent.prompt"
```

```sh
events2="$root/events-silent.jsonl"
cp "$log2" "$events2"
```

6. Grade the silent case from the copy. The evidence check requires one successful tool result that
   holds the case's own token, the installation line, and the silent mode. It prints `silent`:

```sh
jq -s -r --arg token "$silentToken" '
  [ .[] | select(.type == "tool_execution_end" and .isError == false)
    | .result.content[]? | select(.type == "text") | .text ] as $texts
  | select(any($texts[];
      contains($token)
      and contains("Renovate app installed")
      and contains("mode=silent")))
  | "silent"
' "$events2"
```

   The reply check prints the session's reply:

```sh
jq -r 'select(.type == "message_end" and .message.role == "assistant")
  | .message.content[] | select(.type == "text") | .text' "$events2"
```

   The case passes when the reply reports Renovate installed and in Silent mode, and names the log
   it read (`mend/renovate-job.log` or the Mend job log). It fails when the reply reports Renovate
   disabled, missing, or not installed, or names no source.

   Remove the fixture:

```sh
rm -rf "$silent"
```

7. Create the unreadable fixture under the scratch root. It sets `unreadable` and `unreadableToken`.
   A short repository document says the update mode is an app setting, so no repository file
   settles it. Its workflow names the Mend log path, and the file does not exist. The prompt names
   the path, so the case tests the unknown fallback rather than finding it:

```sh
unreadableToken=$(openssl rand -hex 8)
unreadable=$(mktemp -d "$root/unreadable-XXXXXX")
git -C "$unreadable" init --quiet
mkdir -p "$unreadable/.github/workflows" "$unreadable/docs"
cat > "$unreadable/renovate.json" <<'CONFIG'
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["config:recommended"]
}
CONFIG
cat > "$unreadable/docs/dependency-updates.md" <<'DOC'
# Dependency updates

Dependency updates run through the Mend Renovate app. The update mode is an app setting, not a
repository setting.
DOC
cat > "$unreadable/.github/workflows/mend-job.yml" <<'WORKFLOW'
name: Mend Renovate job
on:
  schedule:
    - cron: '0 4 * * *'
jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - run: mend renovate --log mend/renovate-job.log
WORKFLOW
printf '# fixture-token: %s\n' "$unreadableToken" >> "$unreadable/.github/workflows/mend-job.yml"
```

8. Write the unreadable prompt, run the session, set `log3` to the printed `Event log:` path, and
   copy the log into the scratch root. Run the worktree proof from the [QA guide](../../qa.md#reach-it-1)
   again.

```sh
cat > "$root/unreadable.prompt" <<'PROMPT'
This is an automated check with no user present. Never call ask_user_question. This repository uses Mend for dependency updates. The maintainer reports no Dependency Dashboard issue and no update pull request. Work only inside this repository. The job log is mend/renovate-job.log in this repository, and the answer must come from it. Report which mode Renovate runs in.
PROMPT
pnpm pi-session --cwd "$unreadable" --model <pattern> --timeout 300 --prompt-file "$root/unreadable.prompt"
```

```sh
events3="$root/events-unreadable.jsonl"
cp "$log3" "$events3"
```

9. Grade the unreadable case from the copy. The evidence check takes the workflow token from a
   successful result and requires an observed absence of `mend/renovate-job.log` or its `mend`
   directory, or a failed call naming either. It prints `unreadable` and the access it relied on:

```sh
jq -s -r --arg token "$unreadableToken" '
  (map(select(.type == "tool_execution_end")) | map({key: .toolCallId, value: .}) | from_entries) as $ends
  | [ .[] | select(.type == "tool_execution_start")
      | . as $start
      | ($ends[$start.toolCallId] // {}) as $end
      | {
          tool: $start.toolName,
          input: ($start.args.command // $start.args.path // $start.args.pattern // $start.args.code // ""),
          result: ([($end.result.content // [])[]? | select(.type == "text") | .text] | join("\n")),
          isError: ($end.isError // false)
        } ] as $calls
  | [ $calls[] | select(.isError == false) | .result ] as $successTexts
  | [ $calls[]
      | .result | split("\n")[]
      | select(test("mend/renovate-job\\.log|mend/|\u0027mend\u0027|\"mend\"")
          and test("No such file or directory|does not exist|ENOENT"; "i")) ] as $absentLines
  | [ $calls[] | select(.isError == true)
      | select(.input | test("mend/renovate-job\\.log|mend/|\u0027mend\u0027|\"mend\"")) ] as $failedCalls
  | select(($token | length) > 0)
  | select(any($successTexts[]; contains($token)))
  | select(($absentLines | length > 0) or ($failedCalls | length > 0))
  | "unreadable",
    ( ($absentLines[] | "absent | " + .),
      ($failedCalls[] | "failed | " + .tool + " | " + .input) )
' "$events3"
```

   The check proves the session read the workflow that names the log and that it saw the log or its
   directory absent, or tried the log and failed. The reply rule decides the answer.

   The reply check prints the session's reply:

```sh
jq -r 'select(.type == "message_end" and .message.role == "assistant")
  | .message.content[] | select(.type == "text") | .text' "$events3"
```

   The case passes when the reply reports the app's setting as `unknown` and names the log it could
   not read (`mend/renovate-job.log` or the Mend job log). It may also state Renovate's documented
   default when it marks that as the default and says the app may override it. It fails when the
   reply asserts this install's mode or state as a fact, such as silent, enabled, disabled, or full
   without that qualification, or names no source.

   Remove the fixture:

```sh
rm -rf "$unreadable"
```

## Observable results

- Each session command exits with code 0.
- The sync evidence check prints `greppa`, `ruta`, and `tikk`, one per line, and the reply reports
  sync configured in all three projects and names the caller or the reference.
- The silent evidence check prints `silent`, and the reply reports Renovate installed in Silent mode
  and names the log.
- The unreadable evidence check prints `unreadable` and the absent or failed access when a
  successful result holds the workflow token and a result reports `mend/renovate-job.log` or its
  `mend` directory absent, or a failed call names either. The reply reports the app's setting as
  `unknown` and names the log it could not read. A documented default is allowed only when marked
  as the default and qualified by the app override.

## Grading rules

| Case       | Evidence the log must show                                                                                                         | Pass                                                                     | Fail                                                          |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------- |
| Sync       | For each project, a successful result holds `sync-update.yml@v0.1.0` and that project's own token                                  | Sync configured in ruta, tikk, greppa, and the caller or reference named | Sync missing or disabled for any project, or no source named   |
| Silent     | A successful result holds the case's token, `Renovate app installed`, and `mode=silent`                                            | Renovate installed and in Silent mode, and the log named                 | Renovate disabled, missing, or absent, or no source named      |
| Unreadable | A successful result holds the workflow token, and a result reports `mend/renovate-job.log` or its `mend` directory absent, or a failed call names either | App setting reported as `unknown`, and the log it could not read named; a documented default is allowed when marked and qualified by the app override | This install's mode or state asserted as a fact, such as silent, enabled, disabled, or full without that qualification, or no source named |

The token exists only in the case's own source, so a result from another case's fixture cannot pass.
The unreadable check prints the access it relied on.

## Negative controls

Grade both examples with the same rules as their case, with the source evidence unchanged. Both must
fail.

- Sync: "Sync is missing because `stomme-sync.yml` does not exist." The sync case has a successful
  read of each project's caller, so this fails the sync rule even when the reference was read. It
  also names the wrong source.
- Silent: "Renovate is disabled because there is no Dependency Dashboard and no update PR." The
  silent case has a successful read of the log, so this fails the silent rule even when the log was
  read. It also names no source.

These examples check the grader. They are not new model runs, and no run in this feature produces
them on demand.

## End state

Three event logs, one per case, each copied into the scratch root and graded. No fixture directory
remains. The two negative controls fail.

## Gotchas

- A failed session exits with code 1 and prints a `FAIL` line.
- When a session exits with a `FAIL` timeout, copy its event log to its own path, such as
  `events-unreadable-timeout.jsonl`, run the case once more with the same fixture recipe and the same
  tokens, and grade the completed attempt. Record the timed-out attempt's exit code and reason
  beside the completed attempt's log.
- Each prompt starts with the two sentences above, so the session asks no question.
- The fixtures are synthetic. No live GitHub, Mend, or Renovate service is needed.
- The fixtures stay uncommitted because Tau blocks `git commit` in agent bash and the `qa` profile
  has no `commit` tool. The cases read files only, so no check depends on Git history.
- The event logs are copied into the scratch root because the fixture is removed after each case.
- Each fixture is removed after its case, so the next case cannot see it.
