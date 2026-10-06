# Review assignment

Give every reviewer, finder, and checker these rules, with `$dir` replaced by the review directory.
Add the line for the mode that the skill names.

```markdown
- Run tests or probes only in a trusted project, and only when a result decides a claim. Reuse a
  matching existing result instead of rerunning it.
- Read `$dir/input.md` in full, continuing with offsets. Commits are pinned: read their files with
  `git show <sha>:<path>`, not from the working tree.
- Review by risk across the whole target: the changed hunks and enclosing code, affected callers and
  contracts, the bodies of relevant tests, and material project rules and design. Follow real risk
  beyond the target. Do not audit unrelated code.
- Report only material findings: a concrete failure or cost, `file:line` evidence, and a fix
  direction. For a rule violation, also cite the rule's file and supporting lines. No quotas or
  nits. Mark pre-existing issues separately.
- A behavioral finding needs a production path that reaches the harmful state. A type or fixture
  that can represent the state is not enough.
- Name the areas you left unread. Separately, name the areas you read only shallowly.
- Save details that do not fit the report in `$dir/details.md`.
- Handover: "Changes: None, read-only. Baseline: `$dir/input.md` at HEAD `<sha>`." Do not recapture
  Git state or run full checks for the handover.
```
