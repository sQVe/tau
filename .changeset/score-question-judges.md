---
'tau': patch
---

Add `pnpm question-gate-score`. It judges the user's past eligible questions with the configured
classifier and panel, each with and without past examples. It reports decide share and agreement at
cutoffs from 0.50 to 1.00, the lowest tuning cutoff that reaches 95% agreement, and that cutoff's
held-out result. It explores only and sets no launch cutoff.
