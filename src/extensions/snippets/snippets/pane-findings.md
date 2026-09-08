---
name: Read pane findings
description: Read what the other agent panes in this workspace reported
placement: prepend
order: 20
---

The findings for this task are in another herdr pane. Run `herdr pane list`, keep the panes that share your `HERDR_WORKSPACE_ID`, and skip your own `HERDR_PANE_ID`. Read each one with `herdr pane read <pane> --source recent-unwrapped`. Merge what they report into one list, drop the duplicates, and name the panes you read. If you find no other pane, say so instead of guessing what it held.
