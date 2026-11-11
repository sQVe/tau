---
'tau': minor
---

Name the repository's QA guide in every `qa` worker brief. A `qa` launch adds
`QA guide: read .pi/qa.md` when the worktree has that file, and says there is no QA guide when it
does not. The line also appears when the repository has no `qa.repositories` entry. The manager
reads the guide and assigns the sections that a change needs.
