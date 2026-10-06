---
'tau': minor
---

`pr` resolves its target, reuses reviews, and checks the published pull request through a new `pr`
tool instead of shell commands. `target` returns the host, head, base repository and branch,
existing pull request, and merge base. `reuse` tells whether a saved code review still covers the
branch by comparing its diff with the branch diff per path, so a rebase with the same content keeps
the review. `verify` compares the published pull request with the approved title, body, base, draft
status, and local HEAD. Review captures now use fixed `a/` and `b/` diff prefixes, so settings such
as `diff.mnemonicPrefix` no longer change them.
