---
'tau': minor
---

Support optional `checkMessage` argv and `hooks: "run" | "skip"` in root `tau.json`. The staged
candidate selects both; hooks default to run. Message checks receive a temporary full-message file
path and run against staged tools. Message edits rerun message validation without repeating
preparation, project checks, or comment review. Failed checks cannot be waived; checker mutations
stop the group. Missing message checks are reported unavailable.

Preserve normalized message bytes with `git commit --cleanup=verbatim -F`. Reject NUL and undo
commits whose hooks rewrite the checked message. Explicit staged hook bypass applies only to Tau's
final commit, without changing human hooks or configuration. Retain review, TDD, and final
content/path guards. Report cleanup failures without losing completed commit hashes or primary
errors.
