---
'tau': patch
---

Bound `pr_feedback` read results and report cut bodies and lists as gaps. Save the full feedback in
`feedback.json` so omitted evidence can be read without fetching the pull request again. Share a log
excerpt budget across failing checks, cap error text, and return commands for logs cut by the shared
budget. Bound the complete serialized checks result too, including JSON escaping, metadata, and
gaps. Report omitted checks with kept and total counts and a command to read them.
