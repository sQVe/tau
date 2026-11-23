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

The lead owns the user conversation, launch briefs, integration, and commits. It makes no design
choice. The architect owns design, plans, acceptance criteria, and the ticket bodies workers start
from. It does not edit code and launches no editing worker; it may launch investigation workers,
such as `scout`. Tau refuses a launch or follow-up of an editing profile from an architect session.
A session without `TAU_ROLE` is a lead, so the user starts all work in the lead. Workers keep their
`worker` kind.

### The architect session

The lead opens the architect with the `architect` tool. `open` starts or resumes the checkout's
architect to the right of the lead when the lead terminal has a `herdr.space` label, and in a new
named space when it has none. `ask` does not follow that placement rule. It sends one question to
the architect and has two paths. `gate` classifies a user request that no skill covers.

The gate answers `specified`, `open`, or `uncertain`. A label below 0.7, a timeout, an error, or a
missing classifier is `uncertain`, so a failed check reaches the architect instead of hiding a
design decision. The lead follows `specified` and opens the architect on `open`. On `uncertain` the
lead calls `ask` with `gate` set to the gate record path, and never asks the user to pick a route.
Tau builds the question from that record, so the request and the restatement reach the architect
unchanged. The architect answers with `Worker: <notes for the worker brief>` or
`Open the architect: <reason>`. On `Worker:` the lead briefs a worker from the restatement and the
notes. On `Open the architect:` the lead opens the architect. A live architect may talk to the user
first and still answers with one of the two prefixes. Each ask record saves the gate record path in
`gateRecord`, so a review can join an uncertain gate to the architect's route.

The lead calls the gate only for a new user request that no skill covers. A reply that accepts the
lead's own offer, such as "Yes." to "Shall a worker add the test?", follows the offered route
without a gate call.

Every session the lead opens with `open` ends with one final handover whose text starts with
`Final:`. It states the outcome and the lead's next step, and the lead leaves that request alone
until it arrives.

While a session the lead opened runs, the lead starts no editing worker in this checkout, because
the architect can switch the branch during `start-slice` step 9.

A live architect in this checkout takes the question in its inbox, so no second Pi writes its
session file. The architect records its route when it takes the checkout lock: the lock token, its
mode, its terminal, and its Pi session ID. `ask` takes the live path only when that token matches
the live lock holder and the mode is visible. The question names the recorded session and carries
the token, and the architect saves it only while it holds that token. Only the token names the lock
generation that may write: `/resume` changes the session behind a terminal, and a reload keeps the
session ID. Every other holder state refuses with a reason the lead can act on: still starting, a
running hidden ask, another checkout, or an architect from a Tau release before routes. That older
release writes its record after it takes the lock, so its record is never older than its lock. This
tells it apart from an architect that is still starting. A live route whose terminal shows no
`tau.inbox` label refuses before it saves an ask record. An empty value counts as no label. The
label can be missing because the inbox withdraws it with an empty value before the architect
releases its lock. A Pi that does not own its terminal never advertises one. The lead asks again
with the question. A label withdrawn between that check and the send's own read still ends in the
send's refusal. The ask is settled failed like any refused first send.

Recovery never turns one question into two. The lead's own inbox must be listening for its current
session before `ask` sends, because the answer can return only there. The ask ID is the inbox
message ID of both the question and the answer. After a lost reply, a retry resends the same bytes
with the same ID, so the receiver saves each message at most once. A refused send fails the ask only
when no earlier send of the same message ended `unknown`. A refusal writes nothing, so it says
nothing about the first copy, which may still be saved. The architect answers with `architect`
`answer`, which sends only to the lead session that asked. After an `unknown` answer, a retry sends
the kept text again and refuses a file that changed, because the lead may already hold the first
text. A correction goes to the lead as a separate handover. A local error in the answer leaves the
ask open for a fixed retry. An answer the lead inbox confirmed is never reported to the lead as
missing.

The architect cannot send its final handover while an ask to its session is open. Closing stops new
questions and answers, waits a bounded time for work in flight, settles each open ask, and only then
releases the lock. A confirmed answer settles as answered. An answer with an unknown outcome is sent
once more with the same ID, because the lead inbox replies `queued` for a message it already has.
Any other open ask fails, and the lead gets a note to ask again.

When a shutdown ends a visible architect, it also tells its lead it ended, even when no ask is
outstanding. A reload is not such a shutdown: Pi restarts the same session in the same pane, so a
reload still releases the lock and cleans up asks but sends no notice. It sends no notice when a
final handover was confirmed queued to the lead's own terminal; a queued result for another
terminal, and an unknown result, are not confirmation. The notice is best effort and follows
cleanup, because the architect holds the handover result and the lead must be able to resume once
notified.

Without a live holder, `ask` resumes the saved session in a hidden terminal with one question and a
deadline. This path needs the recorded session file. The architect answers, updates the ticket if
needed, sends the answer to the lead's inbox, and ends.

The architect is a Pi session resumed by its saved session file. It can ask the user directly and
keeps its earlier design context and approvals. The checkout records the session file. A lock file
stops two sessions from writing one session file. `open` reports the live visible architect instead
of refusing. A question in the inbox of a live architect in this checkout needs no second writer.

A check of the lock is not a reservation, so the caller that starts the architect takes the lock
first. `open` and the hidden route of `ask` take a claim on the lock before they start Pi, and pass
the claim token to the new Pi in its environment. The new Pi takes the lock over from that claim
with the next lock generation. A Pi started with a claim token takes only that claim. It ends at
session start when the claim is released, gone, or replaced. Once it holds the lock it drops the
token, so a reload takes the lock as usual. A second caller finds the claim held and is refused
before it starts Pi or writes an ask record. While a holder has not published its record, `ask` and
`open` report that the architect is starting.

Pi opens its session file, and can migrate it, before session start. So the caller releases a claim
only when no Pi can still take it over: the new Pi took the lock, its launch failed, or its terminal
has ended. `ask` holds the claim until its hidden terminal ends. `open` waits up to 60 seconds for
the takeover. On that deadline, on a cancel, or when the `ask` wait fails, the caller stops the new
terminal with `hc kill` and releases the claim once the terminal has ended. When the caller does not
know the terminal or the terminal does not end, it keeps the claim.

### The lead's tab

The lead's tab holds only the lead on the left and the architect on the right. Workers open in
`<lead tab>-workers`, and `draft_review` opens tuicr in `<caller tab>-review`. For other terminals
that agents start, the rule is to open a new tab with `tab.new`.

The exception is `handover start` when no workspace exists for the checkout. It creates the
workspace with Pi and its task in the first tab. The operation that starts Pi also creates the
workspace so the user sees the task in the first tab instead of an empty shell. In an existing
workspace, `handover start` uses `tab.new` and leaves existing panes alone. Each handover tab is
named `lead: <name>`, after the short title of its work.

### Models

`roles.lead.model` and `roles.architect.model` choose each role's model from the user file. A
`reviewer` or `checker` launch uses its `model` first; every other profile refuses a launch `model`.
Then a launch uses `roles.<kind>.profiles.<profile>.model` for the launching role, then
`profiles.<profile>.model`, then `profiles.default.model`. This lets a role run the same profile on
a different model. A lead whose session model differs from `roles.lead.model` warns at session
start.

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
- Closing an architect with work in flight can take more than 20 seconds. It waits up to 10 seconds
  for saves and answers in flight. It may then resend an answer with an unknown outcome and send a
  note when that resend fails. Each send waits up to 5 seconds for its reply, after an `hc` terminal
  lookup that has no time limit of its own. Close has no overall deadline.
- A start that cannot be stopped keeps its claim. The checkout then refuses new architect starts
  until the lead session that holds the claim exits, or until the started Pi takes the claim over.
- A lead that dies while its architect starts leaves a claim that reads as gone. A second start can
  then run before the first Pi reaches session start. The first Pi ends there, but it may already
  have opened the session file.

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

### Reserve with a separate start lock

Hold a second lock while the architect starts, and release it once the new Pi holds the architect
lock. Rejected because every reader would need to check both locks, and a claim on the architect
lock gives the same exclusion with one file.

### Refuse a late Pi only at session start

Release the claim on a deadline, and let a Pi that finds its claim gone end at session start.
Rejected because Pi opens and can migrate its session file before session start, so a second Pi
would already have touched the file.

### Wait for the takeover without a deadline

Hold the claim until the new Pi takes it over. Rejected because a Pi that never takes the lock would
block the lead's call until a cancel, and the cancel would still need to stop the Pi.

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
no answer came. Waiting for every ask to be answered can keep the architect open forever. Close does
not wait for every ask to be answered. It waits a bounded time for answers in flight, then settles
the rest and sends a note, so the lead learns the truth.

### Handover text only

Pass design rules and decisions to the lead in handover text. Rejected because the rules drift, each
consult starts cold, and the model depends on how the session started.

### Create a shell tab before starting Pi

Create the workspace from the worktree skill, then open Pi in a second tab. Rejected because the
first tab shows an empty shell instead of the task the user asked to start. The worktree skill still
opens a plain workspace when no handover follows.

### Reuse a tab that appears to hold an idle shell

Split the shell pane to start Pi, then close the shell pane. Rejected because a shell can run a
builtin while remaining the foreground program. Checking the shell name and folder again before
closing does not show that the shell is idle. An extra tab is preferable to ending a user's command.
