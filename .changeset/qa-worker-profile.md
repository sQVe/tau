---
'tau': patch
---

Add a bundled `qa` subagent profile. It runs the app the way the project documents, uses a finished
change as a user would in a browser or on the command line, and reports what a user would hit:
departures from the task or linked spec, regressions, errors, and broken or confusing flows, each
with repro steps and evidence. It does not edit the worktree. The manager sends changes with
user-visible behavior to `qa` alongside the reviewer. Browser testing needs the
`pi-agent-browser-native` package; without it, `qa` tests only on the command line. Known limits: a
QA worker's dev server can clash on ports with another QA worker or a server already running, and
apps behind a login need credentials in the task.
