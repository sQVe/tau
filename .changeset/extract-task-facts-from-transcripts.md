---
'tau': patch
---

The improvement module reads a Pi transcript into its tool calls, extracts task facts from them, and
maps each merged PR to its task with a coverage status. A tool call with an unknown shape becomes
missing evidence and makes its count unknown, not zero. `pnpm session-health` now reads transcripts
through the same parser and prints the same report.
