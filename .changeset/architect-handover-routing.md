---
'tau': patch
---

Fix two architect defects. The visible architect refuses a `handover send` to any terminal other
than its current lead, and a hidden `ask` waits until its terminal exits or its deadline instead of
reporting `needsOpen` when the terminal only paused.
