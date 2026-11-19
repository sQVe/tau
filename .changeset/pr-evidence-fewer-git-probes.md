---
'tau': patch
---

Probe each repository's object format at most once per process and its bare state at most once per
operation, and read the check state once per evidence read. The pr evidence tests spawn fewer Git
processes, so they stay under the timeout on a loaded machine.
