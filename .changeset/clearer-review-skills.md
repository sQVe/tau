---
'tau': patch
---

Make the code-review, triage-findings, and tdd skills clearer. The code-review freshness check now
applies only the exit-status and error-file checks from the capture step. An empty recheck no longer
stops the review; a failed check reports freshness as unknown.
