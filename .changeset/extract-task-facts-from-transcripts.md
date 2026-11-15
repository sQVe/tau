---
'tau': patch
---

The improvement module reads a Pi transcript into its tool calls, extracts task facts from them, and
maps each merged PR to its task with a coverage status. A tool call with an unknown shape becomes
missing evidence and makes its count unknown, not zero. Review signals decide from those facts
whether a task had repeated fix rounds, PR feedback rounds, full check failures, a revert, or a QA
launch after review, and report unknown when a needed fact is missing. `pnpm session-health` now
reads transcripts through the same parser and prints the same report.
