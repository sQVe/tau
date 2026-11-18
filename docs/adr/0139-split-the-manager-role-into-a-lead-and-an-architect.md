# ADR 0139: Split the manager role into a lead and an architect

**Date**: 2026-11-17\
**Status**: Accepted

## Context

One manager session designs the work with the user and orchestrates workers until the PR. Both jobs
run on the session's model. The user wants to talk to a lead on a cheaper model for orchestration
and keep design on a stronger model. The work still needs an interactive design conversation, a
resumable design context, and a record of design choices.

A worker cannot resume a top-level session. A subagent cannot ask the user. Those limits rule out
two ways to separate the design work from the orchestration work.

## Decision

`TAU_ROLE` has `lead` and `architect` as manager kinds, and the lead delegates every code change to
a worker.

The lead owns the user conversation, worker briefs, integration, and commits. It makes no design
choice. The architect owns design, plans, acceptance criteria, and worker briefs. It does not edit
code and launches no editing worker; it may launch investigation workers, such as `scout`. Tau
refuses a launch or follow-up of an editing profile from an architect session. A session without
`TAU_ROLE` is a lead, so the user starts all work in the lead. Workers keep their `worker` kind.

### The architect session

The lead opens the architect with the `architect` tool. `open` starts or resumes the checkout's
architect to the left of the lead when the lead terminal has a `herdr.space` label, and in a new
named space when it has none. `ask` does not follow that placement rule. It sends one question to
the architect and has two paths. While the architect is live in this checkout, `ask` puts the
question in that session's inbox and returns at once. The architect answers, updates the ticket if
needed, and sends the answer with `handover` `send` to the lead terminal, so the answer arrives in
the lead's inbox. Otherwise `ask` resumes the same saved session in a hidden terminal with one
question and a deadline; the architect answers, updates the ticket if needed, sends the answer to
the lead's inbox, and ends. `gate` classifies a user request that no skill covers.

The architect is a Pi session resumed by its saved session file. It can ask the user directly and
keeps its earlier design context and approvals. The checkout records the session file. A lock file
stops two sessions from writing one session file. `open` reports the live visible architect instead
of refusing, and `ask` refuses only when a live holder in another checkout keeps the lock, because
a question in the inbox of a live architect in this checkout needs no second writer.

### The lead's tab

The lead's tab, the first tab of its work space, holds only the architect on the left and the lead
on the right. Every other pane opens in another tab of the same space. Workers open in
`<lead tab>-workers`, `draft_review`'s tuicr opens in `<caller tab>-review`, and a terminal an agent
starts opens in a new tab from `tab.new`.

### Models

`roles.lead.model` and `roles.architect.model` choose each role's model from the user file. A worker
launch uses the launch `model`, then `roles.<kind>.profiles.<profile>.model` for the launching role,
then `profiles.<profile>.model`, then `profiles.default.model`. This lets a role run the same
profile on a different model. A lead whose session model differs from `roles.lead.model` warns at
session start.

The per-profile `route` setting is removed. Its classifier call now serves the gate. The gate's
classifier is fixed at `typesafe/jev-latest`, the one model name in code, because a gate is not a
launch. Its model must not depend on user config, and a wrong gate must not change which model runs
the work.

## Consequences

### Positive

- The user talks to the lead throughout, and design stays with the architect.
- The lead can run a cheaper model for orchestration without changing design quality.
- A resumed architect keeps the design reasoning and approvals instead of starting cold.
- One session file has one writer, and the gate leaves a record of each decision.

### Negative

- A lead that starts from Pi's default model warns instead of switching to `roles.lead.model`.
- A hidden ask resumes a large architect session, so its prompt cache cost can return.
- The split adds a role-specific prompt and model setting to maintain.
- A lead that ignores a skill marker can still decide a design choice itself.
- The user switches tabs to watch a worker or a review.

## Alternatives considered

### One shared manager role

Keep one manager role for design and orchestration. Rejected because its rules drift between the two
jobs, and one model does both jobs. A cheaper model weakens design, and a stronger model pays
orchestration prices.

### An architect subagent

Run the architect as a subagent. Rejected because a subagent cannot ask the user directly, and it
cannot resume the design session with its earlier context.

### Handover text only

Pass design rules and decisions to the lead in handover text. Rejected because the rules drift, each
consult starts cold, and the model depends on how the session started.
