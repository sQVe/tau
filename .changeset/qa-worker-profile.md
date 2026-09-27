---
'tau': patch
---

Add a bundled `qa` subagent profile. It uses a finished change in the app the user already runs from
the worktree, as a user would in a browser or on the command line, and reports what a user would
hit: departures from the task or linked spec, regressions, errors, and broken or confusing flows,
each with repro steps and evidence. It does not edit the worktree or install, build, start, or stop
anything; when the app is not running from the worktree or needs a test account, it asks the manager
to check with the user. The manager passes only test-account credentials, because worker records
keep them. The manager sends changes with user-visible behavior to `qa` alongside the reviewer.
Browser testing needs the `pi-agent-browser-native` package; without it, `qa` tests only on the
command line.
