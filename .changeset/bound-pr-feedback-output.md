---
'tau': patch
---

Bound `pr_feedback` read results and report cut bodies and lists as gaps. Save the full feedback in
`feedback.json` so omitted evidence can be read without fetching the pull request again. Saved
bodies use chunk arrays that join back to the exact text and keep long bodies readable in ranges.
Share a log excerpt budget across failing checks, cap error text, and return commands for logs cut
by the shared budget. Bound the complete serialized checks result too, including JSON escaping,
metadata, and gaps. Report omitted checks with kept and total counts and commands to read check-runs
and commit statuses at the validated head, even if the pull request moves.
