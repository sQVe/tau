---
'tau': patch
---

A Pi process starts its inbox only when it is in the foreground process group of its terminal, so a
Pi started from a session's shell tool no longer removes the session's `tau.inbox` label.
