---
'tau': patch
---

Remove unused internal modules and a duplicate nested `ask_user_question` guard. The subagents and
worker hooks still refuse nested control calls. Behavior is unchanged.
