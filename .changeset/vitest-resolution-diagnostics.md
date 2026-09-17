---
'tau': patch
---

Distinguish unavailable Vitest package lookups from resolver, manifest, and binary failures. Keep
safe error codes/types and available resolution paths in results and saved run records, even when
execution never starts. Omit raw error text and manifest contents. Suggest inspecting the failure
once or using the repository runner; Bash tests do not update Tau observations.
