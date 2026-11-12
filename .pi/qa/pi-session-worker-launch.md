# Worker launch in a Pi session

Only the manager runs this recipe. A session that a worker starts has no `subagent` tool.

## Entry points

`pnpm pi-session`, run in this worktree from a terminal of the `herdr-app` window. A worker launch
needs the `HC_TERMINAL_ID` of that terminal. The launched worker becomes a child of that terminal.

## Driving steps

First, create a scratch repository with one command and a QA guide for it:

```sh
scratch=$(mktemp -d /tmp/tau-qa-XXXXXX)
git -C "$scratch" init --quiet
mkdir "$scratch/.pi"
printf 'notes.txt\n' > "$scratch/.gitignore"

cat > "$scratch/notes" <<'SCRIPT'
#!/bin/sh
set -eu
notes_file="$(dirname -- "$0")/notes.txt"
case "${1-}" in
    add) printf '[ ] %s\n' "$2" >> "$notes_file"; printf 'Added: %s\n' "$2" ;;
    list) awk '{ printf "%d. %s\n", NR, $0 }' "$notes_file" ;;
    *) echo 'Usage: ./notes add <text> | list' >&2; exit 1 ;;
esac
SCRIPT
chmod +x "$scratch/notes"

cat > "$scratch/.pi/qa.md" <<'GUIDE'
# QA guide

This repository ships a local notes CLI, `./notes`.

## Choose sections

| Section   | Test it when the change touches |
| --------- | ------------------------------- |
| Notes CLI | `notes` or note storage         |

## Notes CLI

### Reach it

Run `./notes` commands in the worktree the brief names. Nothing needs to run first.

### What to check

`./notes add <text>` prints `Added: <text>`. `./notes list` then shows `1. [ ] <text>`.
GUIDE
```

Then write the prompt to a file outside the scratch repository. Change the task to trigger the
changed behavior, and keep the first line and the last paragraph.

```sh
cat > "$scratch.prompt" <<PROMPT
This is an automated check with no user present. Never call ask_user_question.
Launch one qa worker with the subagent tool, profile "qa", cwd $scratch, and this task:
"Worktree: $scratch. QA guide: $scratch/.pi/qa.md. Sections: Notes CLI. Data writes: allowed for notes.txt through ./notes commands. Run ./notes add milk, then ./notes list, and report both outputs."
Then end your turn and wait for the worker's report. Do not run ./notes yourself. When the report arrives, reply with the line WORKER-REPORT-SEEN and a one-line summary of the report.
PROMPT
```

Last, run the session, and set `log` to the path it prints after `Event log:`.

```sh
pnpm pi-session --cwd "$scratch" --model <pattern> --prompt-file "$scratch.prompt"
```

## Observable results

- The command exits with code 0 after the worker has reported.
- The "Reach it" proof of "Pi sessions" in the [QA guide](../qa.md) prints this worktree's path.
- The launch succeeded, with the profile and the assignment file of the worker:

  ```sh
  jq -c 'select(.type == "tool_execution_end" and .toolName == "subagent")
    | [.isError, .result.details.labels["tau.profile"], .result.details.labels["tau.assignment"]]' "$log"
  ```

  It prints `false`, `"qa"`, and a path under `~/.pi/agent/tau/`. The folder after `tau/` starts
  with the folder name of this worktree, which shows that the worker loaded this checkout.

- The report reached the session:

  ```sh
  jq -c 'select(.type == "message_start" and .message.role == "custom")
    | [.message.customType, .message.details.outcome]' "$log"
  ```

  It prints `["tau-worker-report","success"]`. A worker that ended without a report prints
  `tau-worker-ended` instead.

- The reply check of the QA guide prints `WORKER-REPORT-SEEN` and a summary with `Added: milk` and
  `1. [ ] milk`.

## Gotchas

- On a timeout the command exits with code 1 and names each worker that still runs, with its `hc`
  address. Stop that worker before the next run.
- The command refuses a `--cwd` that already holds Pi project settings.
- The launched worker costs model tokens too, on the model that Tau routes its profile to, not on
  `--model`.
