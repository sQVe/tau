---
'tau': minor
---

Stage commit groups directly on the real index and use installed Git hooks. Remove preparation,
recovery archives, and Tau-run project and message checks. The commit tool no longer reads
`tau.json`. Comment review and guards against hook rewrites remain in place.

Reject directory requests before staging. Preserve unexpected concurrent staging and clean up
hook-added files from the repository root, including when called from a subdirectory.
