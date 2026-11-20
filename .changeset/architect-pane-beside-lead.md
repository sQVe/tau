---
'tau': patch
---

`architect` `open` starts the architect in a pane to the right of the lead, in the lead's space,
instead of a new herdr-app space. It takes the user's `request` and puts it in the architect's first
message. It reports a live visible architect instead of starting a second one, only while that
architect holds the lock, and it never reuses a hidden `ask` terminal. `open` starts the architect
in a new space when the lead terminal has no herdr-app space.
