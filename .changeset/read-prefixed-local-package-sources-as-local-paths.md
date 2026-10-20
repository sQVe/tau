---
'tau': patch
---

A worker package source such as `github:probe.ts`, `http:probe.ts`, or `https:probe.ts` now resolves
as a local path, as Pi does. Before, a profile package that named the same file was installed a
second time. Sources that start with `git:` or `http://`, `https://`, `ssh://`, or `git://` stay
remote.
