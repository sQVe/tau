---
'tau': minor
---

Launch non-Pi workers without a parent approval dialog. The dialog fired on every launch, and the
model also asked the user first, so each launch cost two approvals for the same configuration. The
sandbox checks remain: native-controls is required, the report directory must already exist inside
the trusted cwd, and native arguments are copied as a literal list. The native harness's own
approval dialogs remain in force; Tau adds no bypass flags and never answers them. Saved records
that carry `configurationApproved` still validate.
