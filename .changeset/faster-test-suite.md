---
'tau': patch
---

Cut the test suite's wall-clock time by supplying the TDD evidence tests with runner reports instead
of spawning a real Vitest process for every step, and by dropping a case that waited out the full
runner timeout.
