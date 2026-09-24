---
'tau': minor
---

Workers no longer hold a capacity slot after cleanup ends unconfirmed. Their records and recovery
references remain available for manual cleanup. Terminal identity checks still protect input and
pane closure.
