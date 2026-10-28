# ADR 0109: Keep action behavior out of extension roots

**Date**: 2026-10-14\
**Status**: Accepted\
**Related**: [ADR 0034 (Check house style outside the editor)](./0034-check-house-style-outside-the-editor.md),
[ADR 0043 (Run subagents as Pi workers with a thin task layer over herdr)](./0043-own-only-the-worker-guarantees-herdr-lacks.md),
[ADR 0120 (Capability modules with an enforced import table)](./0120-capability-modules-with-an-enforced-import-table.md)

## Context

ADR 0120 decides where modules and files live and how files are named. It does not say what an
extension's registration root may hold.

Agents build most features as slices in parallel branches. The busiest integration files held action
behavior next to registration. `subagents.ts` resolved paths, probed HTTP, and refused launches.
`workerExtension.ts`, which Pi loads as the worker's extension, owned report acceptance and reminder
policy. ADR 0050 fixed the same problem for worker control only.

Conflicts come from shared blocks, not from size. Replaying PR #340 and PR #350 on one base
conflicts in `managerPrompt.ts` because a login policy and a URL policy share one template string.
Additions to the `pureModules` registry conflict when they land in the same place. Sorting spreads
unrelated additions apart, but two additions in the same gap still conflict: PR #294 and PR #316
conflict whether the list is sorted or not.

## Decision

Extension registration roots wire and order; action behavior lives in behavior owners. Size stays a
review signal under ADR 0034.

### Extension registration roots

- A registration root is a file that Pi loads as an extension: an extension's named entry, such as
  `subagents.ts`, and a dynamically loaded extension, such as `workerExtension.ts`.
- A root owns registration, dependency setup, lifecycle wiring, and the order that must stay
  central, such as checking trust before probing a launch URL.
- Put each action's policy and execution that change on their own in a behavior owner file of the
  module. An event handler or tool callback calls that owner. A simple host adapter, such as a fixed
  refusal, may stay in the root.
- Keep coupled state changes together. Report acceptance keeps saving, marking, and deadline cleanup
  in one owner.
- Keep pure decisions apart from effectful steps, as ADR 0120 says.
- This rule does not split a flat module or a shared module's entry. ADR 0120 still starts modules
  flat. ADR 0050's coordinator keeps its stated duties.

### Prompt and guidance lists

- A list that composes prompts or guidance holds one policy per item. Do not join two policies that
  change on their own in one string. The composer keeps the final order.

### Unordered registries

- Keep these lists sorted and free of duplicates: `pureModules` in `tests/structure.test.ts` and the
  public files of each module in the module list of `lint/rules/moduleBoundaries.ts`.
  `tests/structure.test.ts` checks both.
- Sorting lowers conflicts only for additions in different places. It does not apply to ordered
  lists such as lint overrides in `vite.config.ts`.

## Consequences

### Positive

- Parallel slices that change different actions edit different behavior owners, and different lines
  of the root and prompt lists.
- The rule extends ADR 0050 and keeps ADR 0120's flat start.

### Negative

- A feature spans more files, and the root still changes once per new action.
- The conflict reduction is not measured. It rests on replayed merges, not on a conflict rate.
- `loadout.ts` and the shared question UI keep mixed responsibilities. They change only when a
  feature gives a reason.

## Alternatives considered

### A hard line limit in lint

Rejected. ADR 0034 already chose review signals, and the prompt conflict came from shared blocks,
not from file size. A count does not show which behavior belongs where.

### Discover pure modules instead of listing them

Mark pure modules in their own files so the registry has no shared list. Rejected because ADR 0120
chose an explicit registry on purpose. Sorting removes some of its conflicts.
