---
'tau': patch
---

Refuse new worker launches while shutdown cleanup runs. Recover pending generic worker starts within
the cleanup budget before stopping them, and retain capacity when ownership cannot be verified.
