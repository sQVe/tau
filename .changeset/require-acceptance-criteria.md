---
'tau': minor
---

Editing worker launches and follow-ups now need acceptance criteria. Pass them as `acceptance`, one
item per criterion, to `subagent` and `subagent_follow_up`. Tau refuses a launch with no criteria or
a blank item before it starts a worker or calls a model. Scout, reviewer, qa, and browser launches
need none. The worker's assignment and `subagent_status` show the criteria. Task records saved by
earlier Tau versions are skipped; start a fresh task instead. The `start-slice` skill passes each
agent ticket's acceptance items to the worker, and `code-review` checks each criterion against
evidence.
