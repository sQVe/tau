---
'tau': patch
---

A Pi process starts its inbox only when it is the foreground process of its terminal, so a child Pi
no longer removes its parent's `tau.inbox` label.
