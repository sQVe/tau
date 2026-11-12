---
'tau': minor
---

Add an optional journey index to the QA guide template, with separate journey files for repeatable
user flows. The manager assigns journeys that the change touches. The `qa` worker reads each
assigned file, walks its steps in order, and compares visible results and the end state.
