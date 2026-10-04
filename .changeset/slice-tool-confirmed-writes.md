---
'tau': minor
---

`slice` writes to Linear through a new `slice` tool. The tool reads the draft and Linear, lists the
exact writes, and applies them only after you confirm them in Pi. It writes nothing when you decline
or when there is no UI. A retry creates only the missing tickets, and merged slices are never
changed. The slice draft is now `plan.json`. A skill's tool stays off until the skill runs, through
`/<name>` or a read of its `SKILL.md`. `docs/tool-authoring.md` holds the rules for writing such a
tool.
