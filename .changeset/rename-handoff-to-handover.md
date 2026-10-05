---
'tau': minor
---

Rename the `handoff` skill to `handover`. It now writes messages to `.tau/handovers` and no longer
reads `.tau/handoffs`. Worker reports use the same word: the status row reads "Handover sections
missing".
