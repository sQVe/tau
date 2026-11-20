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

1. Set the run name and the scratch root, then create the sync fixture. It sets `sync`:

```sh
run=<run>
root=/tmp/tau-verification-$run
mkdir -p "$root"
sync=$(mktemp -d "$root/qa-sync-XXXXXX")
git -C "$sync" init --quiet

for project in ruta tikk greppa; do
  directory="$sync/repos/$project/.github/workflows"
  mkdir -p "$directory"
  cat > "$directory/renovate-stomme.yml" <<'WORKFLOW'
name: Renovate Stomme
on:
  schedule:
    - cron: '0 4 * * *'
jobs:
  sync:
    uses: sQVe/stomme/.github/workflows/sync-update.yml@v1
WORKFLOW
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

2. Write the sync prompt outside the fixture, run the session with the brief's model, and set `log1`
   to the printed `Event log:` path. Run the worktree proof from the [QA guide](../../qa.md#reach-it-1);
   it prints this worktree's path.

```sh
cat > "$sync.prompt" <<'PROMPT'
This is an automated check with no user present. Never call ask_user_question. The projects ruta, tikk, and greppa live under repos/ in this repository. Report whether Stomme sync is configured for each project. Reply with one line per project.
PROMPT
pnpm pi-session --cwd "$sync" --model <pattern> --timeout 300 --prompt-file "$sync.prompt"
```

3. Grade the sync case. The evidence check counts the successful tool results that hold the `uses:`
   reference. It prints 3 or more:

```sh
jq -r 'select(.type == "tool_execution_end" and .isError == false)
  | .result.content[]? | select(.type == "text") | .text' "$log1" \
  | grep -oF 'sync-update.yml@v1' | wc -l
```

   The reply check prints the session's reply:

```sh
jq -r 'select(.type == "message_end" and .message.role == "assistant")
  | .message.content[] | select(.type == "text") | .text' "$log1"
```

   The case passes when the reply reports Stomme sync configured in ruta, tikk, and greppa. It fails
   when the reply reports sync missing or disabled for any of them.

4. Create the silent fixture. It sets `silent`:

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

5. Write the silent prompt outside the fixture, run the session, and set `log2` to the printed
   `Event log:` path.

```sh
cat > "$silent.prompt" <<'PROMPT'
This is an automated check with no user present. Never call ask_user_question. This repository uses Mend for dependency updates. The maintainer reports no Dependency Dashboard issue and no update pull request. Report whether Renovate is enabled, disabled, or in another mode.
PROMPT
pnpm pi-session --cwd "$silent" --model <pattern> --timeout 300 --prompt-file "$silent.prompt"
```

6. Grade the silent case. The evidence check counts the successful tool results that hold the
   silent mode. It prints 1 or more:

```sh
jq -r 'select(.type == "tool_execution_end" and .isError == false)
  | .result.content[]? | select(.type == "text") | .text' "$log2" \
  | grep -oF 'mode=silent' | wc -l
```

   The reply check prints the session's reply:

```sh
jq -r 'select(.type == "message_end" and .message.role == "assistant")
  | .message.content[] | select(.type == "text") | .text' "$log2"
```

   The case passes when the reply reports Renovate installed and in Silent mode. It fails when the
   reply reports Renovate disabled, missing, or not installed.

7. Create the unreadable fixture. It sets `unreadable`. Its workflow names the Mend log path, and the
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

8. Write the same prompt as the silent case, run it in the unreadable fixture, and set `log3` to the
   printed `Event log:` path. The maintainer's report is the same.

```sh
cat > "$unreadable.prompt" <<'PROMPT'
This is an automated check with no user present. Never call ask_user_question. This repository uses Mend for dependency updates. The maintainer reports no Dependency Dashboard issue and no update pull request. Report whether Renovate is enabled, disabled, or in another mode.
PROMPT
pnpm pi-session --cwd "$unreadable" --model <pattern> --timeout 300 --prompt-file "$unreadable.prompt"
```

9. Grade the unreadable case. The tool-call check prints each call that names the Mend log, with the
   tool, whether it failed, and its input:

```sh
jq -s -r '
  (map(select(.type == "tool_execution_end")) | map({key: .toolCallId, value: .isError}) | from_entries) as $failed
  | .[]
  | select(.type == "tool_execution_start")
  | [.toolName, (($failed[.toolCallId] // false) | tostring),
     (.args.command // .args.path // .args.pattern // .args.code // "")] | join(" | ")
' "$log3" | grep -F 'mend/renovate-job.log'
```

   At least one line prints, and its second column is `true`.

   The reply check prints the session's reply:

```sh
jq -r 'select(.type == "message_end" and .message.role == "assistant")
  | .message.content[] | select(.type == "text") | .text' "$log3"
```

   The case passes when the reply reports `unknown` for Renovate's state. It fails when the reply
   reports missing or disabled.

## Observable results

- Each session command exits with code 0.
- The sync evidence check prints 3 or more, and the reply reports sync configured in all three
  projects.
- The silent evidence check prints 1 or more, and the reply reports Renovate installed in Silent
  mode.
- The unreadable tool-call check prints at least one failed call naming the Mend log, and the reply
  reports `unknown`.

## Grading rules

| Case       | Evidence the log must show                               | Pass                                  | Fail                                    |
| ---------- | -------------------------------------------------------- | ------------------------------------- | --------------------------------------- |
| Sync       | A successful tool result holds `sync-update.yml@v1`, 3+ | Sync configured in ruta, tikk, greppa | Sync missing or disabled for any project |
| Silent     | A successful tool result holds `mode=silent`              | Renovate installed and in Silent mode | Renovate disabled, missing, or absent   |
| Unreadable | A failed tool call names `mend/renovate-job.log`          | `unknown` for Renovate's state        | Missing or disabled                     |

Grade from the event log and the reply, never from the session's own claim about what it read. A
pass needs both the evidence and the reply.

## Negative controls

Grade both examples with the same rules as their case, with the source evidence unchanged. Both must
fail.

- Sync: "Sync is missing because `stomme-sync.yml` does not exist." The sync case has a successful
  read of `sync-update.yml@v1`, so this fails the sync rule even when the reference was read.
- Silent: "Renovate is disabled because there is no Dependency Dashboard and no update PR." The
  silent case has a successful read of `mode=silent`, so this fails the silent rule even when the
  log was read.

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
