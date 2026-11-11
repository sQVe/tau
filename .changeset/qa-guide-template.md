---
'tau': minor
---

Add a QA guide template and make the manager and the `qa` worker follow its parts. With a guide, the
manager does the steps under "The manager starts" for the assigned sections, puts the lines the
guide asks for in the brief, and stops what it started when every worker that uses it has reported,
or when the launch fails. It launches no `qa` worker when only "Not testable" applies. The `qa`
worker runs a section's "Reach it" proof first and asks the parent when it fails.
