---
'tau': minor
---

`code_review` has a read-only `evidence` action. It returns the evidence for a saved capture as one
JSON result: the pinned capture, its freshness, the changed paths, the bodies of related test files,
the lines that import each changed module, and the rule and check paths that `input.md` names. A
range or root commit target is read at its pinned commit, never from the working tree. Stale
captures, cut lists and bodies, unreadable files, and missing named paths show up as gaps.
