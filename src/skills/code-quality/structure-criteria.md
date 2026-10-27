# Structure criteria

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

Compare the target with the established patterns of the project:

- Find up to three places where the codebase already solves the same kind of problem, such as
  sibling tools, skills, or modules. Cite each with `file:line`. When fewer than two exist, say so
  and skip the comparison.
- Report a divergence in structure, error handling, test shape, or file layout only when it has a
  structural cost, such as a second way to do one job that readers must learn. Show the cost and why
  the examples face the same constraints as the target.
- When the target's way is better, say so, and propose aligning the older code as a finding.
- Leave violations of written project rules to code-review.

## Plan questions

- What would delete branches, helpers, or layers and keep behavior? (criterion 0)
- Which files in the plan would grow past 500 lines? (criterion 1)
- Which existing code would the plan make more tangled? (criterion 2)
- Which types and boundaries must stay clean for the plan to hold? (criterion 5)
- Which existing module owns this concept? (criterion 6)
- Which writes must succeed together, and which steps depend on others? (criterion 7)
