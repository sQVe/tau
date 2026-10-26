---
'tau': patch
---

`full_check` reuses a passing log for the same files and command, not the same commit and base. A
commit or amend that changes no files no longer reruns the check, and `full_check` takes no `base`.
The `pr` evidence reports `fullCheck` as missing when the newest record ran another command.
