---
'tau': patch
---

Install worker profile packages under one lock per Pi cache and start workers from the installed
package roots, so a worker launch never resolves a remote source again and races another session's
install.
