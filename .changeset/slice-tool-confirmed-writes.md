---
'tau': minor
---

`slice` writes to Linear through a new `slice` tool. The tool reads the draft and Linear, lists the
exact writes, and applies them, then reports each one. A retry creates only the missing tickets, and
merged slices are never changed. The slice draft is now `plan.json`. `docs/skill-authoring.md` holds
the rules for writing such a tool.
