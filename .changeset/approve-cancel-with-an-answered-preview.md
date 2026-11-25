---
'tau': patch
---

Cancel a ticket without the Yes/No dialog when an answered `ask_user_question` approval since the
latest user message selected an option whose own preview has the line `Cancel <ID>` or
`Cancel <ID>: <title>`. Every other cancel still asks.
