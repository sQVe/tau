---
'tau': patch
---

Tests that write improvement events can no longer write outside their temporary directory. A wrong
project root or agent directory now fails before creating any file.
