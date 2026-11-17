---
'tau': patch
---

Test runs remove their temporary folders even when the process exits or receives a signal, and
scratch Git repositories and shared cargo directories register the same cleanup. Saved bash and
codemode output, Pi session event logs, and smoke-run scratch repositories now remove folders older
than a day when the next folder with the same prefix is saved.
