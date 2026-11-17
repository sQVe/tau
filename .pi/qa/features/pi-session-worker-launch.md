# Worker launch in a Pi session

Target: pi-session

Only the manager runs this feature's session. A session that a worker starts has no `subagent`
tool.

## Entry points

`pnpm pi-session`, run in this worktree from a terminal of the `herdr-app` window. A worker launch
needs the `HC_TERMINAL_ID` of that terminal. The launched worker becomes a child of that terminal.

## Driving steps

1. Create a scratch repository under the scratch root. It has an executable notes command, a notes
   target, and a two-step feature file:

```sh
scratch=$(mktemp -d "/tmp/tau-verification-$run/qa-XXXXXX")
git -C "$scratch" init --quiet
mkdir -p "$scratch/.pi/qa/features"
printf 'notes.txt\n.tau/\n.pi/settings.json\n' > "$scratch/.gitignore"

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

cat > "$scratch/.pi/tau.json" <<'CONFIG'
{"verification": {"targets": {"notes": {"launch": ["true"], "doctor": ["test", "-x", "./notes"], "stop": ["true"]}}}}
CONFIG

cat > "$scratch/.pi/qa.md" <<'GUIDE'
# QA guide

This repository ships a local notes CLI, `./notes`.

## Choose sections

| Section   | Test it when the change touches |
| --------- | ------------------------------- |
| Notes CLI | `notes` or note storage         |

## Notes CLI

Target: notes

### Reach it

Run `./notes` commands in the worktree the brief names. Nothing needs to run first.

### Features

- [Notes CLI](./qa/features/notes.md)

### What to check

`./notes add <text>` prints `Added: <text>`. `./notes list` then shows `1. [ ] <text>`.
GUIDE

cat > "$scratch/.pi/qa/features/notes.md" <<'FEATURE'
# Notes CLI

Target: notes

## Entry points

`./notes`, run in the scratch repository.

## Driving steps

1. Run `./notes add milk`. It prints `Added: milk`.
2. Run `./notes list`. It prints `1. [ ] milk`.

## Observable results

Both commands exit with code 0 and print the lines above.

## End state

`notes.txt` holds one unchecked note, `[ ] milk`.

## Gotchas

The `notes.txt` file is ignored, so the run sees no change from it.
FEATURE
```

2. Write the prompt to a file outside the scratch repository. The middle tells the session to
   launch target `notes`, register `features/notes` with 2 steps, and launch the `qa` worker. Keep
   the first line and the last paragraph.

```sh
cat > "$scratch.prompt" <<PROMPT
This is an automated check with no user present. Never call ask_user_question.
Launch the target "notes" with the verification tool. Register the item "features/notes" with 2 steps in the run that launch returns. Then launch one qa worker with the subagent tool, profile "qa", cwd $scratch, and this task:
"Worktree: $scratch. QA guide: $scratch/.pi/qa.md. Features: features/notes. Data writes: allowed for notes.txt through ./notes commands. Feature file: $scratch/.pi/qa/features/notes.md. Verification run: <run>. Run directory: <run directory>. Run ./notes add milk, then ./notes list, and record both steps and the end state with verification_record."
Then end your turn and wait for the worker's report. Do not run ./notes yourself. When the report arrives, stop the run with the verification tool, then reply with the line WORKER-REPORT-SEEN and a one-line summary of the report.
PROMPT
```

3. Run the session. It prints `Event log: <path>` after the worker reports. Set `log` to that path.

```sh
pnpm pi-session --cwd "$scratch" --model <pattern> --timeout 300 --prompt-file "$scratch.prompt"
```

## Observable results

- The command exits with code 0 after the worker has reported.
- The "Reach it" proof of "Pi sessions" in the [QA guide](../../qa.md) prints this worktree's path.
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
- The run-record check finds one run and shows every step passed:

  ```sh
  find "$scratch/.tau/verification" -name run.json
  jq -c '[.steps[].status, .endState.status]' "$scratch"/.tau/verification/*/items/features/notes.json
  ```

  The first command prints one path. The second prints `["passed","passed","passed"]`.
- The stop check shows that the session stopped the run:

  ```sh
  jq '.stop.exitCode' "$scratch"/.tau/verification/*/run.json
  ```

  It prints `0`.

## End state

The scratch repository holds a run whose item has every step passed and whose stop exited with code
0. The session's reply holds `WORKER-REPORT-SEEN`.

## Gotchas

- On a timeout the command exits with code 1 and names each worker that still runs, with its `hc`
  address. Stop that worker before the next run.
- The command refuses a `--cwd` that already holds Pi project settings.
- The launched worker costs model tokens too, on the model that Tau routes its profile to, not on
  `--model`.
- The inner run refuses a record after its stop, so the worker records before the session stops it.
