---
'tau': patch
---

Add the version 1 improvement event record. Events are saved one file per event in
`<project root>/.tau/improvement/`. A damaged event file stops the read with an error naming it, and
an event in a newer format is skipped with a notice to restart the session.
