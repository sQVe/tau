---
'tau': patch
---

The `fullCheck`, `qa`, and `reviews` sections of `tau.json` are now read the same way. `qa` and
`reviews` now refuse an entry key for the current repository that is not `owner/name`, such as
`"tau"`, as `fullCheck` already did. Entries for other repositories are still never read.
