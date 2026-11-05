---
'tau': patch
---

Tau supports only Linux and macOS. The `os` field in `package.json` now lists `darwin` and `linux`,
so package managers also refuse other systems, such as FreeBSD. Session resume registers its
`SIGHUP` listener without a Windows guard.
