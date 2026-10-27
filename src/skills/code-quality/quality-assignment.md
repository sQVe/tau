# Quality assignment

Give every worker `## Common` of the
[shared review rules](../code-review/review-assignment.md#common), with `$dir` replaced by the
review directory, and `## Quality lens`. Paste the whole of
[structure-criteria.md](structure-criteria.md) into every worker task, finder and checker, right
after `## Quality lens`. Never pass it as a link, because review workers get no skill files. Give a
checker `## Checker` too.

## Quality lens

```markdown
Review the target for structure, not defects. The target is a branch diff, named files, or one part
of a repository run.

- Audit the code quality of the target in depth. Rethink how to structure and implement it so that
  quality improves and behavior stays the same.
- Improve abstractions and modularity, reduce tangled code, and make the code shorter and easier to
  read.
- Be ambitious. When a clear path exists that restructures part of the codebase, report it.
- Be thorough and rigorous. Check each claim against the code before you report it.

Apply the structure criteria pasted after this lens. Each one gives what to question, what to flag,
the remedies to prefer, and when a finding is major. Report each major finding as one the author
must justify. Correct behavior does not make a target clean: it is clean only when it has no major
finding, no missed path to a much simpler implementation, no unjustified file-size growth, and none
of the flags below.

Do not be satisfied with "maybe rename this" feedback when the real issue is structural. Do not be
satisfied with a cleaner version of the same messy idea when a plausible path leads to a much
simpler idea.

Be direct, serious, and demanding about quality. Do not be rude, and do not soften major
maintainability issues into mild suggestions. When the code makes the codebase messier, say so
clearly. When the implementation missed a chance for a large simplification, say that too.

Report findings in this order:

1. Structural code-quality regressions.
2. Missed chances for a large simplification.
3. Increases in spaghetti or branching complexity.
4. Boundary, abstraction, and type-contract problems that make the code harder to reason about.
5. File-size and decomposition concerns.
6. Modularity and abstraction issues.
7. Legibility and maintainability concerns.

Do not flood the report with low-value nits when larger structural issues exist. Report a few
high-conviction findings, not a long list of cosmetic notes.

Report the other issues as explicit, actionable findings that push for a cleaner decomposition.

Each finding gives:

- `file:line` evidence.
- A sketch of the simpler structure.
- What it deletes and what it adds.
- The contracts, callers, order, errors, and state that stay the same.
- The label `restructure` when the fix needs a design decision of its own, changes a contract that
  code outside the repository uses, or grows the change a lot. Take about 100 added lines or about 3
  more files as guidance for a large fix, not a cutoff, and do not decide by file count alone.
  Otherwise the label `local`, even when the fix moves a helper between modules and updates its
  callers in the repository.
- `major` when it matches a Major line in the structure criteria, and its level in the priority
  order.

Before you propose a deletion, read the history of that code with `git log -L` or
`git log --follow`, and name why the code exists.

Compare the target with the planned structure in `## Intent` of `input.md`. It lists the structure
rules the slice follows and the files each agent ticket names. Use it as follows:

- A harmful departure from the plan joins the finding it causes. Name the plan item in that
  finding's evidence, such as a bespoke helper where the plan named one to reuse (criterion 6).
- A departure that improves on the plan is a plan-correction note, not a finding. Give each note its
  `file:line`, the plan item, and why the change is better. Report notes after the findings, under
  their own heading, and keep them out of the findings.
- A touched file missing from the plan's files is not a departure.
- When `## Intent` says the planned structure is unavailable, make no plan comparison. A missing
  plan is never a departure.

Do not search for defects. List a defect you meet in a separate Defects list, not as a structure
finding.
```

## Checker

```markdown
- Confirm that the code each finding would delete exists.
- Check the contracts that the finding keeps against callers and tests.
- For a pattern finding, confirm that the cited examples exist, share the pattern, and face the same
  constraints as the target.
- Confirm each label against its definition in the quality lens. Report a wrong label as refuting
  that part of the finding.
- Mark each finding supported, refuted, or uncertain, with a reason drawn only from what you or the
  evidence returned.
```
