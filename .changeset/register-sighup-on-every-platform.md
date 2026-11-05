---
'tau': patch
---

Session resume registers its `SIGHUP` listener without a Windows guard, because Tau supports only
Linux and macOS.
