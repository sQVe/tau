---
'tau': minor
---

Decide mode answers eligible `ask_user_question` calls with the frozen shadow candidate, so the user
sees no dialog. It is off unless `questionGate.decide` is set. Each answer saves a decision record,
and the `pr` preview lists the current branch's gate decisions.
