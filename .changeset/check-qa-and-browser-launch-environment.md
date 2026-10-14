---
'tau': patch
---

`qa` and `browser` worker launches take an optional `url` for the app under test. Before the worker
starts, Tau checks that the worktree exists and that the URL answers. A failed check refuses the
launch and names the missing worktree or server, such as "no server at http://localhost:3000". The
worker's task gets the checked URL as an `App URL:` line, and the manager guidance tells the manager
to pass `url`.
