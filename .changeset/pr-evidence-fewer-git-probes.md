---
'tau': patch
---

Probe each repository's object format and bare state at most once per operation, and read the check
state once per evidence read. A standalone `pr` `coverage` read is one operation. A new operation
probes again, so a repository replaced at the same path is read with its new format. A probe that
fails is not remembered, so the next call asks Git again. The pr evidence tests spawn fewer Git
processes per pr evidence read.
