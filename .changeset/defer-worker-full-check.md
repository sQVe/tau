---
'tau': minor
---

`subagent` and `subagent_follow_up` take an optional `fullCheck: { owner, reason }` for an editing
assignment whose tree cannot pass the full check by design. The checkout root must configure a full
check command. The worker still runs `full_check`. Its `success` report is accepted when it cites
the newest record for the current tree and command, whether that record passed or failed, even when
a newer record of another command exists. The report names the owner and the record result. Without
the declaration, the gate still requires a passing record.
