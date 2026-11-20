# Status from the system's own source

Target: pi-session

A `qa` worker runs this feature. It checks that a session reads a system's own configuration or run
record before it reports an integration or workflow as missing or disabled, and that it reports
`unknown` when that source cannot be read. Each case runs in its own temporary Git repository. The
expected answers and the grader stay in this file, outside the fixtures and the prompts.

## Entry points

`pnpm pi-session`, run in this worktree. Each case starts Pi in its own scratch working directory
and sends one prompt.

## Driving steps

1. Set the run name and the scratch root, then create the sync fixture. It sets `sync`. Do not add a
   `mise.toml`; no case installs the Stomme CLI.

```sh
run=<run>
root=/tmp/tau-verification-$run
mkdir -p "$root"
sync=$(mktemp -d "$root/qa-sync-XXXXXX")
git -C "$sync" init --quiet

for project in ruta tikk greppa; do
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

2. Create the silent fixture. It sets `silent`:

```sh
silent=$(mktemp -d "$root/qa-silent-XXXXXX")
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
```

3. Create the unreadable fixture. It sets `unreadable`. Its workflow names the Mend log path, and the
   file does not exist:

```sh
unreadable=$(mktemp -d "$root/qa-unreadable-XXXXXX")
git -C "$unreadable" init --quiet
mkdir -p "$unreadable/.github/workflows"
cat > "$unreadable/renovate.json" <<'CONFIG'
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["config:recommended"]
}
CONFIG
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
```

4. Write the sync prompt outside the fixture, run the session with the brief's model, and set `log1`
   to the printed `Event log:` path. Run the worktree proof from the [QA guide](../../qa.md#reach-it-1);
   it prints this worktree's path.

```sh
cat > "$sync.prompt" <<'PROMPT'
This is an automated check with no user present. Never call ask_user_question. The projects ruta, tikk, and greppa live under repos/ in this repository. Report whether Stomme sync is configured for each project. Reply with one line per project.
PROMPT
pnpm pi-session --cwd "$sync" --model <pattern> --timeout 300 --prompt-file "$sync.prompt"
```

5. Grade the sync case. The evidence check ties each project to its own caller file. It prints one
   line per project whose caller was read in a successful call that held the `uses:` reference:

```sh
jq -s -r --arg silentName "$(basename "$silent")" --arg unreadableName "$(basename "$unreadable")" '
  (map(select(.type == "tool_execution_end" and .isError == false))
    | map({key: .toolCallId, value: ([.result.content[]? | select(.type == "text") | .text] | join("\n"))})
    | from_entries) as $results
  | .[]
  | select(.type == "tool_execution_start")
  | (.args.command // .args.path // .args.pattern // .args.code // "") as $input
  | ($results[.toolCallId] // "") as $result
  | select(($input | contains($silentName)) | not)
  | select(($input | contains($unreadableName)) | not)
  | select($result | contains("sync-update.yml@v0.1.0"))
  | ["ruta", "tikk", "greppa"][]
  | . as $project
  | select($input | test("repos/" + $project + "([/\\s]|$)"))
  | $project
' "$log1" | sort -u
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
  | .message.content[] | select(.type == "text") | .text' "$log1"
```

   The case passes when the reply reports sync configured in ruta, tikk, and greppa, and names the
   caller file `renovate-stomme.yml` or the `sync-update.yml` reference. It fails when the reply
   reports sync missing or disabled for any project, or names no source.

6. Write the silent prompt outside the fixture, run the session, and set `log2` to the printed
   `Event log:` path. Run the worktree proof from the [QA guide](../../qa.md#reach-it-1) again.

```sh
cat > "$silent.prompt" <<'PROMPT'
This is an automated check with no user present. Never call ask_user_question. This repository uses Mend for dependency updates. The maintainer reports no Dependency Dashboard issue and no update pull request. Report whether Renovate is enabled, disabled, or in another mode.
PROMPT
pnpm pi-session --cwd "$silent" --model <pattern> --timeout 300 --prompt-file "$silent.prompt"
```

7. Grade the silent case. The evidence check requires one successful call that read the case's own
   log and saw both the installation line and the silent mode. It prints at least one line:

```sh
jq -s -r --arg syncName "$(basename "$sync")" --arg unreadableName "$(basename "$unreadable")" '
  (map(select(.type == "tool_execution_end" and .isError == false))
    | map({key: .toolCallId, value: ([.result.content[]? | select(.type == "text") | .text] | join("\n"))})
    | from_entries) as $results
  | .[]
  | select(.type == "tool_execution_start")
  | (.args.command // .args.path // .args.pattern // .args.code // "") as $input
  | ($results[.toolCallId] // "") as $result
  | select(($input | contains($syncName)) | not)
  | select(($input | contains($unreadableName)) | not)
  | select($input | contains("mend/renovate-job.log"))
  | select($result | contains("Renovate app installed"))
  | select($result | contains("mode=silent"))
  | [.toolCallId, $input] | @tsv
' "$log2"
```

   The reply check prints the session's reply:

```sh
jq -r 'select(.type == "message_end" and .message.role == "assistant")
  | .message.content[] | select(.type == "text") | .text' "$log2"
```

   The case passes when the reply reports Renovate installed and in Silent mode, and names the log
   it read (`mend/renovate-job.log` or the Mend job log). It fails when the reply reports Renovate
   disabled, missing, or not installed, or names no source.

8. Write the same prompt as the silent case, run it in the unreadable fixture, and set `log3` to the
   printed `Event log:` path. The maintainer's report is the same. Run the worktree proof from the
   [QA guide](../../qa.md#reach-it-1) again.

```sh
cat > "$unreadable.prompt" <<'PROMPT'
This is an automated check with no user present. Never call ask_user_question. This repository uses Mend for dependency updates. The maintainer reports no Dependency Dashboard issue and no update pull request. Report whether Renovate is enabled, disabled, or in another mode.
PROMPT
pnpm pi-session --cwd "$unreadable" --model <pattern> --timeout 300 --prompt-file "$unreadable.prompt"
```

9. Grade the unreadable case. The tool-call check prints each call that names the case's own log,
   with its status: `failed` when the call failed, `absent` when a result line names the log and
   says it is absent, and `present` otherwise. It must print at least one `failed` or `absent` line:

```sh
jq -s -r --arg syncName "$(basename "$sync")" --arg silentName "$(basename "$silent")" '
  (map(select(.type == "tool_execution_end")) | map({key: .toolCallId, value: .}) | from_entries) as $ends
  | .[]
  | select(.type == "tool_execution_start")
  | (.args.command // .args.path // .args.pattern // .args.code // "") as $input
  | select($input | contains("mend/renovate-job.log"))
  | select(($input | contains($syncName)) | not)
  | select(($input | contains($silentName)) | not)
  | ($ends[.toolCallId] // {}) as $end
  | ([($end.result.content // [])[]? | select(.type == "text") | .text] | join("\n")) as $result
  | (if $end.isError == true then "failed"
     elif ($result | split("\n") | any(test("mend/renovate-job\\.log") and test("No such file or directory|does not exist|ENOENT"; "i"))) then "absent"
     else "present" end) as $status
  | [.toolName, $status, $input] | join(" | ")
' "$log3"
```

   The reply check prints the session's reply:

```sh
jq -r 'select(.type == "message_end" and .message.role == "assistant")
  | .message.content[] | select(.type == "text") | .text' "$log3"
```

   The case passes when the reply reports `unknown` for Renovate's state and names the log it could
   not read (`mend/renovate-job.log` or the Mend job log). It fails when the reply reports missing
   or disabled, or does not name the log.

## Observable results

- Each session command exits with code 0.
- The sync evidence check prints `greppa`, `ruta`, and `tikk`, one per line, and the reply reports
  sync configured in all three projects and names the caller or the reference.
- The silent evidence check prints at least one line, and the reply reports Renovate installed in
  Silent mode and names the log.
- The unreadable evidence check prints at least one `failed` or `absent` line, and the reply reports
  `unknown` and names the log it could not read.

## Grading rules

| Case       | Evidence the log must show                                                                                                       | Pass                                                                     | Fail                                                          |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------- |
| Sync       | For each project, a successful call whose input names `repos/<project>` and whose result holds `sync-update.yml@v0.1.0`          | Sync configured in ruta, tikk, greppa, and the caller or reference named | Sync missing or disabled for any project, or no source named   |
| Silent     | A successful call whose input names `mend/renovate-job.log` and whose result holds `Renovate app installed` and `mode=silent`    | Renovate installed and in Silent mode, and the log named                 | Renovate disabled, missing, or absent, or no source named      |
| Unreadable | A failed call naming the case's own `mend/renovate-job.log`, or a result line naming it and saying it is absent                 | `unknown` for Renovate's state, and the log it could not read named       | Missing or disabled, or no log named                          |

Grade from the event log and the reply, never from the session's own claim about what it read. A
pass needs both the evidence and the reply. Evidence from another case's fixture does not count:
each check rejects a call whose input names another case's fixture directory.

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

Three event logs, one per case, each with its evidence check and reply graded. The two negative
controls fail.

## Gotchas

- A failed session exits with code 1 and prints a `FAIL` line.
- Each prompt starts with the two sentences above, so the session asks no question.
- The fixtures are synthetic. No live GitHub, Mend, or Renovate service is needed.
- The fixtures stay uncommitted because Tau blocks `git commit` in agent bash and the `qa` profile
  has no `commit` tool. The cases read files only, so no check depends on Git history.
- The `read` and `bash` tools mark a missing file as an error, so the failed-read check does not
  depend on file permissions.
