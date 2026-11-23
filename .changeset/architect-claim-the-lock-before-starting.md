---
'tau': patch
---

`architect` `open` and the hidden route of `ask` take the architect lock before they start Pi. A
second caller is refused before it starts Pi or writes an ask record. A one-shot start ticket fences
each launch: the child renames the ticket before it runs Pi, and a caller that abandons a launch
cancels the ticket and releases its claim only when the rename proves no Pi can run. A `.started`
marker makes a new caller refuse while its terminal is live or unread, so a claim whose lead died no
longer lets a second Pi open the session file. A launch whose child took the ticket is looked up for
up to 10 seconds; the lookup bounds each `hc` call and treats a partial read as unread. Hidden ask
records change only while they are `running`, under the per-ask lock, so `sent`, `timeout`, and
`failed` are final. A hidden ask enforces its own deadline, and a reader repairs a running ask whose
terminal has ended.
