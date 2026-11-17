# Delegate a check

## Who

A manager session. The manager launches and runs the session of the
[worker-launch feature](../features/pi-session-worker-launch.md). A `qa` worker, briefed with the
run, the scratch repository, the event log, and the saved session output, runs each step's
read-only check and records the results with `verification_record`. The manager stops the outer run
after the worker reports, and the user takes no step.

## Goal

Delegate a check to a `qa` worker and get its report.

## Test

The manager launches the `pi-session` target with the `verification` tool, registers this journey
with 6 steps, creates the scratch repository under the scratch root, and runs the session with
stdout and stderr saved in `<run directory>/session.txt` and the exit code in
`<run directory>/session-exit.txt`. The brief names the run, the run directory, the scratch
repository, and the event log. After the worker reports, the manager stops the outer run. If the
session fails or times out, the manager still briefs the worker, which records the failing steps.

## Steps

1. Check the scratch repository and its prompt:
   `test -x "$scratch/notes"` and `jq . "$scratch/.pi/tau.json"` exit with code 0, and
   `$scratch.prompt` exists.
2. Check the saved session output: `session-exit.txt` holds `0`, and `session.txt` has an
   `Event log:` line. Set `log` to that path and run the
   [QA guide's worktree proof](../../qa.md#reach-it-1). It prints this worktree's path.
3. Run the launch check under the
   [feature's observable results](../features/pi-session-worker-launch.md#observable-results).
   It prints `false`, `"qa"`, and an assignment path under `~/.pi/agent/tau/`.
   The folder after `tau/` starts with this worktree's folder name.
4. Run the feature's report check and the [QA guide's reply check](../../qa.md#what-to-check-1).
   The report check prints `["tau-worker-report","success"]`.
   The reply contains `WORKER-REPORT-SEEN`, `Added: milk`, and `1. [ ] milk`.
5. Run the feature's run-record check.
   `find "$scratch/.tau/verification" -name run.json` prints one path.
   `jq -c '[.steps[].status, .endState.status]'` on
   `$scratch/.tau/verification/*/items/features/notes.json` prints
   `["passed","passed","passed"]`.
6. Run the feature's stop check.
   The run directory still exists, and `jq '.stop.exitCode'` on its `run.json` prints `0`.

## End state

The session's reply holds `WORKER-REPORT-SEEN`, `Added: milk`, and `1. [ ] milk`.
The scratch repository holds a run whose item has every step passed.
