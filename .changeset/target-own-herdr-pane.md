---
'tau': patch
---

The workflow instructions now tell agents to open herdr-app panes beside their own pane. An agent
passes its own pane to `pane.split`, starts the terminal in a folder with `env -C`, and checks the
new terminal's space and folder with `hc get` before it reports where it runs.
