---
'tau': patch
---

Probe each repository's object format and bare state at most once per process, and read the check
state once per evidence read. The pr evidence tests spawn fewer Git processes, so they stay under
the timeout on a loaded machine.
