# ADR 0109: Keep action behavior out of extension roots and name one concept one way

**Date**: 2026-10-14\
**Status**: Accepted\
**Related**: [ADR 0035 (Use size thresholds as review guidance)](./0035-use-size-thresholds-as-review-guidance.md),
[ADR 0050 (Split worker control into a coordinator and one controller per worker)](./0050-split-worker-control-into-a-coordinator-and-one-controller-per-worker.md),
[ADR 0120 (Capability modules with an enforced import table)](./0120-capability-modules-with-an-enforced-import-table.md)

## Context

ADR 0120 decides where modules and files live and the case of file names. It does not say what an
extension's registration root may hold, or how a module names one concept.

Agents build most features as slices in parallel branches. Over the 90 days to 2026-10-14, 71 of 309
merged PRs edited the subagents entry (`subagents.ts`, before that `index.ts`). The busiest
integration files hold action behavior next to registration. `subagents.ts` (933 lines) resolves
paths, probes HTTP, and refuses launches in `checkLaunchEnvironment`. `workerExtension.ts` (1,002
lines), which Pi loads as the worker's extension, owns report acceptance and reminder policy. ADR
0050 fixed the same problem for worker control only.

Conflicts come from shared blocks, not from size. Replaying PR #340 and PR #350 on one base
conflicts in `managerPrompt.ts`, a 33-line file, because a login policy and a URL policy share one
template string. Additions to the `pureModules` registry conflict when they land in the same place.
Sorting spreads unrelated additions apart, but two additions in the same gap still conflict: PR #294
and PR #316 conflict whether the list is sorted or not.

File names mix word orders inside some modules. `reviewCapture/` holds `reviewCapture.ts` beside
`captureReview.ts`, so a reader cannot tell which is the entry. Two of 17 folder modules show clear
mixed patterns. The rest use one local pattern, often verb and decision pairs such as `verify.ts`
and `verifyDecisions.ts`. Testing a strict owner-first rule on ten real names made several worse:
`incompleteReport` becomes `reportIncomplete`, and `passiveWait` becomes `waitPassive`.

## Decision

Extension registration roots wire and order; action behavior lives in behavior owners; each module
names one concept one way. Size stays a review signal under ADR 0035.

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

### File names

- Use one noun for one concept inside a module, and keep files about the same concept in one local
  family, such as `report*` or `verify` with `verifyDecisions`.
- No file reverses its module's name, such as `captureReview.ts` beside `reviewCapture.ts`. This
  covers private files and extra public files.
- A noun alone names what the file holds, such as `record.ts`. A plural noun alone names a
  collection.
- Keep an established domain phrase when it matches a config key or exported concept, such as
  `allowedModels.ts` or `requiredFor.ts`.
- Tests keep their source name, as ADR 0120 says.

### Existing code

- One refactor moves the measured hotspots: launch behavior out of `subagents.ts` and report
  behavior out of `workerExtension.ts`. It also renames `captureReview.ts`, sorts and checks the two
  registries, splits each multi-policy item in `managerPrompt.ts`, and splits
  `controller/controller.test.ts` (4,475 lines) by behavior, as ADR 0120 already requires. Tests
  stay at the public boundary they already defend.
- Other actions still live in the roots, such as follow-up, status, reply, and cancel in
  `subagents.ts`, and worker questions, input, startup, and activity in `workerExtension.ts`. Move
  such an action into a behavior owner when a feature changes it.
- After the refactor, apply the rules to new files. Rename an existing file only for a real
  ambiguity, in its own small change, after checking active unlanded work and the file's importers.
  Squash-merged branch refs are not active work.

## Consequences

### Positive

- Parallel slices that change different actions edit different behavior owners, and different lines
  of the root and prompt lists.
- A reader can tell the entry of a module from its other files, and finds one concept under one
  noun.
- The rule extends ADR 0050 and keeps ADR 0120's flat start.

### Negative

- A feature spans more files, and the root still changes once per new action.
- The conflict reduction is not measured. It rests on replayed merges, not on a conflict rate.
- Which noun names a concept still needs judgment in review. Only registry order is checked.
- The refactor blocks other subagents work while it runs.
- `loadout.ts` and the shared question UI keep mixed responsibilities. They change only when a
  feature gives a reason.

## Alternatives considered

### A hard line limit in lint

Rejected. ADR 0035 already chose review signals, and the measured prompt conflict happened in a
33-line file. A count does not show which behavior belongs where.

### Owner noun first in every private file name

Rejected. It fixed the two mixed modules but made established names worse, and the owner of a file
such as `compactionWorkers.ts` is unclear without reading it. Phi uses this rule because its files
belong to a few user-facing nouns, such as pane and tab. Tau's modules own tools, workers, records,
and profiles.

### Rename on touch

Rejected. A rename changes importers, tests, and registry entries, so it widens the merge surface of
the very feature work that overlaps other branches.

### Discover pure modules instead of listing them

Mark pure modules in their own files so the registry has no shared list. Rejected because ADR 0120
chose an explicit registry on purpose. Sorting removes some of its conflicts.
