---
'tau': patch
---

Improve commit failure diagnostics by including trimmed hook output in `CommitFailedError` messages,
and add coverage for the whitespace-only stderr fallback case.
