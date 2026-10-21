# Quality assignment

Give every worker `## Common` of the
[shared review rules](../code-review/review-assignment.md#common), with `$dir` replaced by the
review directory, and `## Quality lens`. Give a checker `## Checker` too.

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

Apply these criteria. Each one gives what to question, what to flag, the remedies to prefer, and
when a finding is major. Report each major finding as one the author must justify. Correct behavior
does not make a target clean: it is clean only when it has no major finding, no missed path to a
much simpler implementation, no unjustified file-size growth, and none of the flags below.

0. Simplify the structure ambitiously.
   - Do not stop at "this could be a bit cleaner." Ask whether a restructuring keeps behavior, makes
     the code much simpler, and needs fewer concepts, branches, or helper layers.
   - Look for a restructuring that deletes branches, helpers, modes, conditionals, or layers, and
     that uses the existing architecture better. Prefer the structure with the fewest moving parts.
     When you can delete complexity instead of rearranging it or spreading it around, push for the
     deletion.
   - Flag a complicated implementation where a cleaner reframing could delete whole categories of
     complexity.
   - Flag refactors that move code around without reducing the number of concepts a reader must
     hold.
   - Remedy: delete a whole layer of indirection instead of polishing it.
   - Remedy: reframe the state model so conditionals disappear instead of moving to one place.
   - Remedy: turn special-case logic into a simpler default flow with fewer exceptions.
   - Major: the change keeps a lot of incidental complexity when a plausible restructuring would
     delete it.
1. A change must not push a file from under 500 lines to over 500 lines without a strong reason.
   - Always report a change that pushes a file past 500 lines. For a target with no diff, such as
     named files, report each file over 500 lines. Treat this as a strong code-quality smell by
     default. Ask whether the new code could be split out.
   - Ask whether the change grew a file or component past 500 lines.
   - Waive the rule only for a compelling structural reason, when the resulting file is still
     clearly organized.
   - Remedy: when a change crosses the threshold, propose decomposing the code first.
   - Remedy: split into helpers, subcomponents, modules, or local abstractions only when the split
     makes behavior easier to trace.
   - Flag a missed decomposition that would materially improve maintainability.
   - Major: the change pushes a file from below 500 lines to above 500 lines.
2. Do not allow spaghetti growth in existing code.
   - Ask whether the change added branching where a better abstraction should exist.
   - Ask whether repeated conditionals signal a missing model or helper.
   - Ask whether a cohesive module became more coupled, more stateful, or harder to scan.
   - Be suspicious of new ad-hoc conditionals, scattered special cases, and one-off branches in
     unrelated flows.
   - Treat conditionals added in random places as a design problem, not a style nit.
   - Flag one-off booleans, nullable modes, or flags that complicate existing control flow.
   - Flag narrow edge-case handling in the middle of an already busy function.
   - Flag temporary branching that is likely to become permanent debt.
   - Report changes that make the surrounding code harder to reason about, even when they work.
   - Remedy: move the logic into a dedicated abstraction, helper, or separate module.
   - Remedy: use a state machine or policy object only when it makes behavior easier to trace.
   - Remedy: collapse duplicate branches into one clearer flow.
   - Remedy: replace condition chains with a typed model or an explicit dispatcher.
   - Major: the change adds ad-hoc branching that makes an existing flow more tangled.
3. Clean the design, not only the behavior.
   - When behavior can stay the same and the structure can get meaningfully cleaner, propose the
     cleaner version. Ask whether the change improves or worsens the local architecture.
   - Do not accept an implementation because it works when it leaves the codebase messier. Flag
     refactors that pass tests but make the code less modular or less readable.
   - Remedy: extract a helper or pure function.
4. Prefer direct, plain code over hacky or magic code.
   - Ask whether the implementation is direct and readable, or relies on special cases and
     incidental control flow.
   - Ask whether each abstraction earns its keep or is only a wrapper.
   - Treat brittle, ad-hoc, or magic behavior as a code-quality problem. Be skeptical of generic
     mechanisms that hide simple data-shape assumptions.
   - Flag thin abstractions, identity wrappers, and pass-through helpers that add indirection
     without clarity.
   - Remedy: delete wrappers that do not clarify the API.
   - Major: the change adds an unnecessary abstraction, wrapper, or cast-heavy contract that makes
     the design more indirect.
5. Press on type and boundary cleanliness when it affects maintainability.
   - Ask whether the change added casts, optionality, or ad-hoc object shapes that hide the real
     invariant.
   - Question needless optionality, `unknown`, `any`, optional parameters, and casts where a clearer
     type boundary could exist. Prefer explicit typed models and shared contracts over loosely
     shaped ad-hoc objects.
   - When a branch uses a silent fallback to cover an unclear invariant, propose an explicit
     boundary.
   - Remedy: make type boundaries more explicit so the control flow gets simpler.
6. Keep logic in the canonical layer and reuse existing helpers.
   - Ask whether the logic lives in the right file, layer, and package, or whether the change leaked
     details across a boundary.
   - Report feature logic that leaks into shared paths.
   - Report implementation details that leak through APIs.
   - Flag feature-specific logic in general-purpose modules.
   - Flag copy-pasted logic instead of extracted helpers.
   - Flag bespoke helpers where the codebase already has a canonical utility.
   - Remedy: reuse the existing canonical helper instead of adding a bespoke one-off or
     near-duplicate.
   - Remedy: move code to the package, service, or module that already owns the concept instead of
     accepting architectural drift.
   - Remedy: change the ownership boundary so the feature becomes a natural extension of an existing
     abstraction.
   - Remedy: move feature-specific logic behind a dedicated abstraction.
   - Major: the change solves a local problem by scattering feature checks across shared code, or
     duplicates an existing helper, or puts logic in the wrong layer when a clear canonical home
     exists.
7. Treat needless sequential orchestration and non-atomic updates as design smells when the cleaner
   structure is obvious.
   - Ask whether the orchestration is more sequential or less atomic than it needs to be.
   - When independent work runs in sequence for no good reason, propose running it in parallel when
     that also keeps the flow clearer.
   - When related updates can leave state half applied, propose a more atomic structure.
   - Do not focus on micro-optimizations. Do report avoidable orchestration complexity that makes
     the implementation more brittle.
   - Remedy: separate orchestration from business logic.
   - Remedy: prefer a more atomic flow when partial state would be harder to reason about.

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
- The label `restructure` when the fix moves code or ownership between modules, changes a contract
  that other modules use, or edits files outside the target. Otherwise the label `local`.
- `major` when it matches a Major line above, and its level in the priority order.

Before you propose a deletion, read the history of that code with `git log -L` or
`git log --follow`, and name why the code exists.

Compare the target with the established patterns of the project:

- Find up to three places where the codebase already solves the same kind of problem, such as
  sibling tools, skills, or modules. Cite each with `file:line`. When fewer than two exist, say so
  and skip the comparison.
- Report a divergence in structure, error handling, test shape, or file layout only when it has a
  structural cost, such as a second way to do one job that readers must learn. Show the cost and why
  the examples face the same constraints as the target.
- When the target's way is better, say so, and propose aligning the older code as a `restructure`
  finding.
- Leave violations of written project rules to code-review.

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
