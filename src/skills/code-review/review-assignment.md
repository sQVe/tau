# Review assignment

Give every worker `## Common`, with `$dir` replaced by the review directory. Add `## First review`
and `## Defect lens` for a first review, or `## Fix review` for a fix review. Give a fast reviewer
`## Fast budget` too, and a checker `## Checker`. Give every worker the
[decision evidence guidance](../shared/decision-evidence.md) and ask for its change-specific
assessment in the report. A fix review reassesses affected conclusions without reusing earlier
verdicts. A checker checks the finder's decision evidence as well as its findings.

## Common

```markdown
- Run a test or probe only in a trusted project, and only when its result decides a claim.
- Read `$dir/input.md` in full, continuing with offsets, and `$dir/evidence.md` when it exists. Read
  pinned commits with `git show <sha>:<path>`, not from the working tree.
- Cite only source, lines, and results that the capture, the evidence file, or your own script
  returned. Before you cite a fact that a script filtered out, gather it and return it.
- Name the areas you left unread and, separately, the areas you read only shallowly.
- Save details that do not fit the report in `$dir/details.md`.
- Handover: "Changes: None, read-only. Baseline: `$dir/input.md` at HEAD `<sha>`." Do not recapture
  Git state or run full checks for it.
```

## First review

```markdown
- Review by risk across the whole target: the changed hunks and enclosing code, affected callers and
  contracts, the bodies of relevant tests, and material project rules and design. Follow real risk
  beyond the target. Do not audit unrelated code.
```

## Fix review

```markdown
- Review only the fix diff and the callers in the evidence. Do not search for unrelated or older
  defects.
- For each finding in `## Intent`, say whether the fix closes it, with `file:line` evidence.
- Report a new finding only when the fix causes it. Name its failure, `file:line` evidence, and a
  fix direction.
```

## Fast budget

```markdown
- Spend about five minutes.
- Run `date` when you start and between files.
- Read the riskiest changed code first.
- When the five minutes have passed, stop reading and write the report.
- End the report with a `## Unread files` section that lists each captured file you did not read, or
  says "None".
```

## Defect lens

```markdown
- Map each acceptance criterion in `## Intent` to the evidence that it is met. Report a criterion
  with no evidence, or one you cannot check, as a finding.
- Each finding names a concrete failure or cost, `file:line` evidence, and a fix direction. A rule
  violation also cites the rule's file and lines. Mark pre-existing issues apart.
- For each changed condition or guard, name the test that fails if it is inverted. Report a guard
  that no test defends.
- For each changed or rewritten test, name any behavior the old version checked that the new one no
  longer checks. Report each loss.
- A behavioral finding needs a production path that reaches the harmful state. A type or fixture
  that can represent the state is not enough.
```

## Checker

```markdown
- First check each finder candidate against source, guards, callers, and tests. Mark it supported,
  refuted, or uncertain, with a reason drawn only from what you or the evidence returned.
- Then look for omissions in the changed behavior and its tests. Label each new one checker-new.
```
