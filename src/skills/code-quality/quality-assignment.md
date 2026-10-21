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

Apply these standards:

0. Be ambitious about structural simplification.
   - Do not stop at "this could be a bit cleaner."
   - Look for a restructuring that keeps behavior and deletes branches, helpers, modes,
     conditionals, or layers, and that uses the existing architecture better.
   - Prefer the structure that leaves the fewest moving parts. When you can delete complexity
     instead of rearranging it, push for the deletion.
   - Each simplification gives a sketch of the simpler structure, what it deletes and adds, and what
     must stay the same.
1. A change must not push a file from under 500 lines to over 500 lines without a strong reason.
   - Always report a change that pushes a file past 500 lines. For a target with no diff, such as
     named files, report each file over 500 lines.
   - Treat this as a strong code-quality smell by default.
   - Propose a split into helpers, subcomponents, modules, or local abstractions only when the split
     makes behavior easier to trace.
   - When a change crosses the threshold, propose decomposing the code first.
   - Waive the rule only for a compelling structural reason, when the resulting file is still
     clearly organized.
2. Do not allow spaghetti growth in existing code.
   - Be suspicious of new ad-hoc conditionals, scattered special cases, and one-off branches in
     unrelated flows.
   - Treat conditionals added in random places as a design problem, not a style nit.
   - Prefer moving the logic into a dedicated abstraction, helper, or separate module. Prefer a
     state machine or policy object only when it makes behavior easier to trace.
   - Report changes that make the surrounding code harder to reason about, even when they work.
3. Clean the design, not only the behavior.
   - When behavior can stay the same and the structure can get meaningfully cleaner, propose the
     cleaner version.
   - Do not accept an implementation because it works when it leaves the codebase messier.
   - Prefer a simplification that removes moving pieces over a refactor that spreads the same
     complexity around.
4. Prefer direct, plain code over hacky or magic code.
   - Treat brittle, ad-hoc, or magic behavior as a code-quality problem.
   - Be skeptical of generic mechanisms that hide simple data-shape assumptions.
   - Report thin abstractions, identity wrappers, and pass-through helpers that add indirection
     without clarity.
5. Press on type and boundary cleanliness when it affects maintainability.
   - Question needless optionality, `unknown`, `any`, and casts where a clearer type boundary could
     exist.
   - Prefer explicit typed models and shared contracts over loosely shaped ad-hoc objects.
   - When a branch uses a silent fallback to cover an unclear invariant, propose an explicit
     boundary.
6. Keep logic in the canonical layer and reuse existing helpers.
   - Report feature logic that leaks into shared paths and implementation details that leak through
     APIs.
   - Prefer existing canonical utilities over bespoke one-offs.
   - Move code to the right package, service, or module instead of accepting architectural drift.
7. Treat needless sequential orchestration and non-atomic updates as design smells when the cleaner
   structure is obvious.
   - When independent work runs in sequence for no good reason, propose running it in parallel.
   - When related updates can leave state half applied, propose a more atomic structure.
   - Do not focus on micro-optimizations. Do report avoidable orchestration complexity that makes
     the implementation more brittle.

For every meaningful change, ask:

- Is there a restructuring that keeps behavior and makes this much simpler?
- Can the change be reframed so it needs fewer concepts, branches, or helper layers?
- Does this improve or worsen the local architecture?
- Did the change add branching where a better abstraction should exist?
- Did a cohesive module become more coupled, more stateful, or harder to scan?
- Does this logic live in the right file and layer?
- Did the change grow a file or component past 500 lines?
- Do repeated conditionals signal a missing model or helper?
- Is the implementation direct and readable, or does it rely on special cases and incidental control
  flow?
- Does this abstraction earn its keep, or is it only a wrapper?
- Did the change add casts, optionality, or ad-hoc object shapes that hide the real invariant?
- Does this logic live in the canonical layer, or did the change leak details across a boundary?
- Is this orchestration more sequential or less atomic than it needs to be?

Escalate a finding when you see:

- A complicated implementation where a cleaner reframing could delete whole categories of
  complexity.
- Refactors that move code around but do not reduce the number of concepts a reader must hold.
- A file that the change pushes past 500 lines, especially when the new code could be split out.
- New conditionals added to unrelated code paths.
- One-off booleans, nullable modes, or flags that complicate existing control flow.
- Feature-specific logic in general-purpose modules.
- Generic magic handling that hides simple structure.
- Thin wrappers or identity abstractions that add indirection without simplifying anything.
- Needless casts, `any`, `unknown`, or optional parameters that muddy the real contract.
- Copy-pasted logic instead of extracted helpers.
- Narrow edge-case handling in the middle of an already busy function.
- Refactors that pass tests but make the code less modular or less readable.
- Temporary branching that is likely to become permanent debt.
- Bespoke helpers where the codebase already has a canonical utility.
- Logic in the wrong layer or package when it should live somewhere more central.
- Sequential async flow where independent work could run in parallel and stay clearer.
- Partial-update logic that leaves state less atomic than necessary.

When you find a problem, prefer these remedies:

- Delete a whole layer of indirection instead of polishing it.
- Reframe the state model so conditionals disappear instead of moving to one place.
- Change the ownership boundary so the feature becomes a natural extension of an existing
  abstraction.
- Turn special-case logic into a simpler default flow with fewer exceptions.
- Extract a helper or pure function.
- Split a large file into smaller focused modules, only when the split makes behavior easier to
  trace.
- Move feature-specific logic behind a dedicated abstraction.
- Replace condition chains with a typed model or an explicit dispatcher.
- Separate orchestration from business logic.
- Collapse duplicate branches into one clearer flow.
- Delete wrappers that do not clarify the API.
- Reuse the existing canonical helper instead of adding a near-duplicate.
- Make type boundaries more explicit so the control flow gets simpler.
- Move the logic to the package, module, or layer that already owns the concept.
- Run independent work in parallel when that also simplifies the orchestration.
- Restructure related updates into a more atomic flow when partial state would be harder to reason
  about.

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

Correct behavior does not make a target clean. A target without major structural issues has:

- no clear structural regression
- no obvious missed chance to make the implementation much simpler, when such a path is visible
- no unjustified file-size growth
- no obvious spaghetti growth from special-case branching
- no hacky or magic abstraction that makes the code harder to reason about
- no needless wrapper, cast, or optionality churn that hides the real design
- no clear architecture-boundary leak and no avoidable duplication of a canonical helper
- no missed decomposition that would materially improve maintainability

Report each of these as a major finding that the author must justify:

- The change keeps a lot of incidental complexity when a plausible restructuring would delete it.
- The change pushes a file from below 500 lines to above 500 lines.
- The change adds ad-hoc branching that makes an existing flow more tangled.
- The change solves a local problem by scattering feature checks across shared code.
- The change adds an unnecessary abstraction, wrapper, or cast-heavy contract that makes the design
  more indirect.
- The change duplicates an existing helper, or puts logic in the wrong layer when a clear canonical
  home exists.

Report the other issues as explicit, actionable findings that push for a cleaner decomposition.

Each finding gives:

- `file:line` evidence.
- A sketch of the simpler structure.
- What it deletes and what it adds.
- The contracts, callers, order, errors, and state that stay the same.
- The label `restructure` when the fix moves code or ownership between modules, changes a contract
  that other modules use, or edits files outside the target. Otherwise the label `local`.
- `major` when it matches the list of major findings above, and its level in the priority order.

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
