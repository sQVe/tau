---
'tau': minor
---

Show subagent results and notices as readable lines instead of raw JSON. Each status, reply, and
history result uses the same state icons and wording, with worker names, local deadlines, and
evidence errors. Expanded rows (ctrl+o) show the full task ID, the deadline enforcement, the report
summary and evidence, and the shortened records and session paths. Notices render the same way, and
results saved before this change keep Pi's default rendering.

History distinguishes loaded rows hidden by collapse from matches on another page. Expanded history
shows the next offset when another page is available. Reply guidance clarifies that `notResent` does
not confirm the original Pi delivery.
