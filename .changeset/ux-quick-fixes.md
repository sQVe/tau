---
'tau': patch
---

Strip ANSI escapes and lint-staged progress lines from commit hook failures. Mark the
`ask_user_question` length limits as hard limits, keep the pr publish question's `problem` short,
post `--body-file` comments only after the file write returns, name one `write` call per file as the
way to write several files, and hand an approved task over after creating its worktree from the bare
repository root.
