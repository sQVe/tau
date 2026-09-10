---
name: Read pane findings
description: Gather relevant information from other panes in this workspace
placement: prepend
order: 20
---

Other herdr panes in this workspace may contain relevant information. Run `herdr pane list`, keep the panes that share your `HERDR_WORKSPACE_ID`, and skip your own `HERDR_PANE_ID`. Read each one with `herdr pane read <pane> --source recent-unwrapped`. Summarize the relevant information, drop the duplicates, and name the panes you read. If you find no other pane, say so instead of guessing what it held.
