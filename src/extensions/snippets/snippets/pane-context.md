---
name: Read other panes
description: Gather what the other panes in this workspace hold about this task
placement: prepend
order: 20
---

Other herdr panes in this workspace may contain relevant information. Run `herdr pane list`, keep the panes that share your `HERDR_WORKSPACE_ID`, and skip your own `HERDR_PANE_ID`. Read each one with `herdr pane read <pane> --source recent-unwrapped`. Summarize what they hold about this task, merge points that repeat across panes, and name the panes you read. If you find no other pane, say so instead of guessing what it held.
