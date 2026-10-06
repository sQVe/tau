---
'tau': patch
---

End the manager's turn when a worker launch or follow-up refuses because worker capacity is full. If
other tool results keep the turn running, block the next tool calls and end the turn. Allow tools
again when a worker notice or user message arrives. Check capacity refusal before other tool guards
so blocked calls also end the turn.
