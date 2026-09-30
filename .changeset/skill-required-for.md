---
'tau': minor
---

Skills can name the actions they must own in `metadata.required-for` in their frontmatter. Tau adds
one line per such skill to the system prompt, so the agent uses the skill even when the action is a
step in its own plan. The `pr`, `pr-feedback`, `update-branch`, `worktree`, and `handoff` skills now
declare their actions. Tau refuses to load when a `required-for` value is empty or not a string, or
when a Tau skill file has broken frontmatter, and it names the skill file.
