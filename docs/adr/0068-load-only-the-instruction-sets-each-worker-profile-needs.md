# ADR 0068: Load only the instruction sets each worker profile needs

- Status: Accepted; the list of set names, the `qa` sets, and the delivery order superseded by
  [ADR 0076](./0076-give-browser-workers-one-shared-set-of-browser-rules.md)
- Date: 2026-09-29

## Context

- Tau appends three instruction sets to the system prompt: writing, coding, and workflow. A worker
  loads the parent's whole Pi configuration, so every worker got all three on every turn.
- Scouts and QA workers do not write code, so for them the coding instructions are sent on every
  turn without use.
- Reviewers do not edit code either, but they judge code against the coding instructions.
- A worker reads its instructions from its saved task and appends them itself, so a follow-up gets
  them without resending ([ADR 0066](./0066-add-taus-prompt-text-to-pis-append-section.md)).

## Options considered

- Keep every set for every worker. Rejected: this costs about 4.4k characters per turn for scouts
  and QA.
- Choose the sets by role, so investigation profiles drop the coding set. Rejected: the reviewer is
  an investigation profile but needs the coding set.
- Send the list of sets to the worker through an environment variable. Rejected: the worker reads
  its saved task, so a follow-up would lose a list that only the launch environment carried.
- Name the sets in the profile and save them in the task loadout. Chosen: each profile gets the sets
  its role needs, and a follow-up keeps them.

## Decision

A profile's `instruction-sets:` setting names the instruction sets its worker loads.

### Profiles

- The setting is a comma-separated list of `writing`, `coding`, and `workflow`. An unknown name
  makes the profile invalid.
- Without the setting, a profile gets all three sets. User and project profiles keep their behavior.
- The bundled `scout` and `qa` profiles load `writing` and `workflow`, because they do not write
  code.
- The bundled `reviewer` loads all three, because reviewers judge code against the coding
  instructions.
- The bundled `worker` loads all three, because it writes code.

### Delivery

- The launch saves the sets in the task loadout. Task record format 5 adds them. A follow-up of a
  task saved in an earlier format gets all three sets, which is what it had.
- In a worker process, the writing, coding, and workflow extensions do not append their text. The
  worker appends the sets from its saved task after its own instructions, in the order writing,
  coding, workflow.

## Tradeoffs

- Scouts and QA workers no longer receive the coding instructions on each turn.
- Measured on bridged Claude workers with Pi 0.87.1, the first request of a scout drops from 13,581
  to 12,172 tokens and of a QA worker from 10,786 to 9,378. Each system prompt drops by 4,421
  characters.
- A follow-up keeps the sets of its original launch, as it keeps its tools and skills.
- Cost: a user profile for a role that does not write code must set `instruction-sets:` to save the
  same text.
- Cost: an instruction set added later needs a new name in the setting and a new record format.

## See also

- [ADR 0053: Version each saved record format](./0053-version-each-saved-record-format.md)
- [ADR 0056: Load workflow rules apart from coding and writing](./0056-load-workflow-rules-apart-from-coding-and-writing.md)
- [ADR 0066: Add Tau's prompt text to Pi's append section](./0066-add-taus-prompt-text-to-pis-append-section.md)
- [ADR 0067: Give workers only their profile's tools and skills](./0067-give-workers-only-their-profile-tools-and-skills.md)
