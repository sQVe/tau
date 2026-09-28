---
'tau': minor
---

Cap worker reports in parent notices and `subagent_status` results at 8,000 characters of summary
and evidence. A capped result carries `truncated: true` and `reportFile`, the path of the saved
report, which keeps the full text.
