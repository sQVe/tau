---
'tau': patch
---

The tracker reads its own `tracker` config. A case-duplicate or bad `tracker.repositories` entry for
another repository no longer stops the tracker lines for this checkout. A duplicate entry for this
checkout's repository still stops them and names both keys.
