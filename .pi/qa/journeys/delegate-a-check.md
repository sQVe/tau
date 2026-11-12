# Delegate a check

## Who

A manager session. Only a manager walks this journey, never a `qa` worker or the user.

## Goal

Delegate a check to a `qa` worker and get its report.

## Test

By hand with the headless Pi command `pnpm pi-session`, because it runs a real model and worker.
Use the model named in the brief and a terminal of the `herdr-app` window.

## Steps

1. Create the scratch repository and prompt with the
   [worker-launch recipe's driving steps](../pi-session-worker-launch.md#driving-steps).
   The scratch repository has the executable notes command and its QA guide; the prompt file sits
   outside it.
2. Run the recipe's `pnpm pi-session` command.
   It exits with code 0 and prints `Event log: <path>` after the worker reports.
   Set `log` to that path. Run the [QA guide's worktree proof](../../qa.md#reach-it-1).
   It prints this worktree's path.
3. Run the launch check under the
   [recipe's observable results](../pi-session-worker-launch.md#observable-results).
   It prints `false`, `"qa"`, and an assignment path under `~/.pi/agent/tau/`.
   The folder after `tau/` starts with this worktree's folder name.
4. Run the recipe's report check and the [QA guide's reply check](../../qa.md#what-to-check-1).
   The report check prints `["tau-worker-report","success"]`.
   The reply contains `WORKER-REPORT-SEEN`, `Added: milk`, and `1. [ ] milk`.

## End state

The session's reply holds `WORKER-REPORT-SEEN`, `Added: milk`, and `1. [ ] milk`.
