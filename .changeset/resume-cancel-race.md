---
'tau': patch
---

Cancelling a worker while the parent is reattaching to it no longer starts a second cleanup. The
worker stays owned until its one cleanup finishes.
