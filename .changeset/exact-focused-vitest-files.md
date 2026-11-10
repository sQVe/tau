---
'tau': patch
---

Make focused runs on Vitest 2.1.0 or later select exact file paths. A selected file no longer runs
other test files whose paths contain its name. Older Vitest versions keep CLI substring file
matching.
