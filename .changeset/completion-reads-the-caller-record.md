---
'tau': patch
---

Review capture completion decides from the record its caller already read. Inspection, coverage, and
the fix chain check each use one read of `capture.json`, so a record replaced during a check can no
longer make the decision and the returned record disagree.
