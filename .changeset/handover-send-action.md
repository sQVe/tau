---
'tau': minor
---

Add `send` and `start` actions to the `handover` tool. `send` sends a prepared handover file to
another terminal with `hc send` and reports `started`, `notStarted`, or `blocked`. `start` opens a
Pi tab with the handover file as its task in a herdr-app space, or in a new space.
