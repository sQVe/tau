---
'tau': patch
---

Code review evidence, freshness, PR reuse, PR chain coverage, and fix captures now refuse a
`capture.json` that is a symlink or has another hard link. A fix capture's freshness check also
checks the earlier review directory first. PR chain coverage still reports a missing or malformed
record as unknown, but any other read failure now stops the check with an error.
