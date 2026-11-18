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
the architect and has two paths. `gate` classifies a user request that no skill covers.

An architect that takes the checkout lock records its route: the lock token, its mode, its terminal,
and its Pi session ID. The mode is visible, or ask for a hidden ask. `ask` takes the live path only
when the recorded token matches the live lock holder and the mode is visible. The send names the
recorded session, so the inbox refuses the question when that terminal now runs another session. A
holder without a matching route is still starting, and the lead asks again shortly. An architect
from a Tau release before routes is the exception. It writes a version 1 record without a route
after it takes the lock, so that record is never older than its lock. The lock stamps its start when
a claim wins, after the old holder is gone, so a newer architect's lock is never older than the
version 1 record it replaces. For an older architect, `ask` tells the lead to wait until it closes,
because it takes no live asks and may be a hidden ask without a pane. A running hidden ask comes
before both messages, and the lead waits for its answer. The question also carries the lock token,
and the architect saves it only while it holds that token. A reload or restart between the lead's
read and the send therefore refuses the question, even when the terminal keeps its session. A holder
in ask mode is a running hidden ask, and `ask` refuses until it ends. A live holder in another
checkout also refuses.

On the live path, the lead must have a working inbox for its own session, or `ask` refuses before it
sends. `ask` saves an ask record with an ask ID, the lead's terminal and session, and the
architect's session. It sends the question with the ask ID as the message ID and returns when the
inbox replies. A missing reply makes the result `unknown`. The lead then retries with the ask ID,
which sends the same text with the same message ID and never starts a hidden ask. The architect
answers with `architect` `answer` and the ask ID. The action sends the answer to the lead's recorded
terminal and session, starts it with the ask ID, and marks the ask answered. A local error in the
answer leaves the ask open, so the architect fixes the file and calls `answer` again with the same
ask ID. Local errors include a missing, empty, or oversized file, or an answer larger than one inbox
message. A delivery refusal marks the ask failed. A lead terminal that runs a new session refuses
the answer, and the architect tells the user.

The architect cannot send its final handover while an ask to its session is open. When it closes
anyway, its inbox stops before it releases the lock. It then marks each open ask failed and sends
the lead a note to ask again.

Without a live holder, `ask` resumes the saved session in a hidden terminal with one question and a
deadline. This path needs the recorded session file. The architect answers, updates the ticket if
needed, sends the answer to the lead's inbox, and ends.

The architect is a Pi session resumed by its saved session file. It can ask the user directly and
keeps its earlier design context and approvals. The checkout records the session file. A lock file
stops two sessions from writing one session file. `open` reports the live visible architect instead
of refusing. A question in the inbox of a live architect in this checkout needs no second writer.

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
- A question saved just before the architect's inbox closes shows only when that session resumes.
  The lead gets a note to ask again.

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
