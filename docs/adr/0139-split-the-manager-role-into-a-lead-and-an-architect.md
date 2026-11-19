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

A live architect in this checkout takes the question in its inbox, so no second Pi writes its
session file. The architect records its route when it takes the checkout lock: the lock token, its
mode, its terminal, and its Pi session ID. `ask` takes the live path only when that token matches
the live lock holder and the mode is visible. The question names the recorded session and carries
the token, and the architect saves it only while it holds that token. Only the token names the lock
generation that may write: `/resume` changes the session behind a terminal, and a reload keeps the
session ID. Every other holder state refuses with a reason the lead can act on: still starting, a
running hidden ask, another checkout, or an architect from a Tau release before routes. That older
release writes its record after it takes the lock, so its record is never older than its lock. This
tells it apart from an architect that is still starting.

Recovery never turns one question into two. The lead's own inbox must be listening for its current
session before `ask` sends, because the answer can return only there. The ask ID is the inbox
message ID of both the question and the answer. After a lost reply, a retry resends the same bytes
with the same ID, so the receiver saves each message at most once. A refused send fails the ask only
when no earlier send of the same message ended `unknown`. A refusal writes nothing, so it says
nothing about the first copy, which may still be saved. The architect answers with `architect`
`answer`, which sends only to the lead session that asked. A local error in the answer leaves the
ask open for a fixed retry. An answer the lead inbox confirmed is never reported to the lead as
missing.

The architect cannot send its final handover while an ask to its session is open. Closing stops new
questions and answers, waits a bounded time for work in flight, settles each open ask, and only then
releases the lock. A confirmed answer settles as answered. An answer with an unknown outcome is sent
once more with the same ID, because the lead inbox replies `queued` for a message it already has.
Any other open ask fails, and the lead gets a note to ask again.

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
- Closing an architect with work in flight waits up to about 20 seconds: 10 for saves and answers in
  flight, one inbox exchange to resend an answer with an unknown outcome, and one more for the note
  when that resend fails.

## Alternatives considered

### One shared manager role

Keep one manager role for design and orchestration. Rejected because its rules drift between the two
jobs, and one model does both jobs. A cheaper model weakens design, and a stronger model pays
orchestration prices.

### An architect subagent

Run the architect as a subagent. Rejected because a subagent cannot ask the user directly, and it
cannot resume the design session with its earlier context.

### Refuse questions while the architect is live

Keep the lock as a refusal for every ask. Rejected because the lead and architect sit side by side,
so the architect is live most of the time, and the user would switch panes for every question.

### Route a live ask by terminal or by Pi session ID

Send to the recorded terminal, or to the session behind it. Rejected because both outlive a lock
generation. `/resume` puts another session behind the terminal, and a reload keeps the session ID
while the lock is released and taken again. Only the lock token names the session that may write.

### Answer with a plain handover send

Let the architect send the answer with `handover` `send` to the lead terminal. Rejected because the
model would have to carry the lead's session and the ask ID by itself. Nothing would tie the answer
to its ask or mark the ask answered, and `/new` in the lead would redirect the answer.

### Ask again as a new question after a lost reply

Rejected because the receiver may already hold the first copy. The architect would then answer the
same question twice. Reusing the message ID lets the receiver keep one copy.

### Close at once, or only after every ask is answered

Closing at once fails answers that are still sending, and the lead gets the answer and a note that
no answer came. Waiting for every ask to be answered can keep the architect open forever. A bounded
wait, then a settle and a note, keeps closing finite and tells the lead the truth.

### Handover text only

Pass design rules and decisions to the lead in handover text. Rejected because the rules drift, each
consult starts cold, and the model depends on how the session started.
