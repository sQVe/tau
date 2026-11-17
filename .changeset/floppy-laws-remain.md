---
'tau': patch
---

The visible architect closes only after a queued `handover` send with `final: true`. Other queued
sends keep it running, and `final` is refused outside `send`.
