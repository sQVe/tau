---
'tau': minor
---

`code-review` captures its input and checks freshness through a new `code_review` tool instead of
shell blocks. The tool creates the review directory, captures the target with its hash, and reports
the review as fresh, stale, or unknown. It lists binary, unreadable, excluded, and unmatched files
as gaps, and never writes to the Git index or object store. The review input, the reviewer and
checker assignments, and the report shape are now templates next to the skill.
