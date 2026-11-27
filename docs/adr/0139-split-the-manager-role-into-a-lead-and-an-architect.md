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
until it arrives. A resumed architect may keep earlier lead terminals in its transcript, so the
visible architect refuses a `handover send` to any terminal other than its current lead. The refusal
names both terminals, and a refused send queues nothing.

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
reload still cleans up asks but keeps the lock for the next runtime and sends no notice. It sends no
notice when a final handover was confirmed queued to the lead's own terminal; a queued result for
another terminal, and an unknown result, are not confirmation. The notice is best effort and follows
cleanup, because the architect holds the handover result and the lead must be able to resume once
notified.

Without a live holder, `ask` resumes the saved session in a hidden terminal with one question and a
deadline. This path needs the recorded session file. The architect answers, updates the ticket if
needed, sends the answer to the lead's inbox, and ends. The lead's wait ends only when the terminal
exits or the ask reaches its deadline; a status change or message does not end it. The ask session
marks its record `failed` and shuts down when its run settles without an answer, so a real miss ends
the wait quickly.

The architect is a Pi session resumed by its saved session file. It can ask the user directly and
keeps its earlier design context and approvals. The checkout records the session file. A lock file
stops two sessions from writing one session file. `open` reports the live visible architect instead
of refusing. A question in the inbox of a live architect in this checkout needs no second writer.

A check of the lock is not a reservation, so the caller that starts the architect takes the lock
first. `open` and the hidden route of `ask` take a claim on the lock before they start Pi, and pass
the claim token to the new Pi in its environment. The new Pi takes the lock over from that claim
with the next lock generation. A Pi started with a claim token takes only that claim. It ends at
session start when the claim is released or replaced. Once it holds the lock it drops the token. A
reload keeps the lock by handing the token to the next runtime. A second caller finds the claim held
and is refused before it starts Pi or writes an ask record. While a holder has not published its
record, `ask` and `open` report that the architect is starting.

Pi opens its session file, and can migrate it, before session start. So the caller releases a claim
only when no Pi can still take it over. A one-shot start ticket fences the launch before Pi opens
the session file. Before it launches, the caller creates an empty file
`.tau/architect/start/<claimToken>.lead.<leadPid>` through `ensureTauDirectory`. The child's argv is
wrapped so a shell renames the ticket before it runs Pi:
`sh -c 'mv -- "$1" "$1.started.$$" 2>/dev/null || exit 75; shift; exec "$@"' tau-architect-start <ticket> <the Pi argv>`.
The wrapper applies to the `hc run` argv in `ask`, the `space.new` argv, and the argv inside
`env -C` for `pane.split`. `$$` is the shell's process ID, and `exec` keeps that ID for `env` and
Pi. The marker is an empty file whose name carries the process ID, so the child and the caller
cannot both take the ticket. The argv still contains `TAU_ARCHITECT_CLAIM=<token>`.

The ticket and marker names are a synchronization protocol, not a saved record. The files are empty
and only their names carry meaning, so ADR 0053 does not version them. A name with a known token
prefix that is not a ticket, a started or adopted marker, or a cancelled ticket is refused as
malformed. A `.started` or `.adopted` name without a valid process ID is refused with its path. A
name a later release does not recognise therefore never lets a second Pi start.

The proof that a taken child cannot run Pi is `processState(pid) === 'gone'`. A dead process cannot
exec, and a child paused between its rename and its `exec` is alive, so the fence stays. `running`
and `unknown` are never proof, and a reused process ID errs toward refusal. Absence from `hc` means
nothing anywhere, and no launch lookup exists. The caller stops a taken child by process ID:
`SIGTERM`, then up to 5 seconds for `gone`, then `SIGKILL`, then up to 5 more seconds. The 10
seconds share one absolute deadline. `gone` releases the claim and deletes the marker; anything else
keeps both. The caller keeps its own copy of the child's process ID from the first marker read.
Neither a later read nor another caller's lock can change that copy. A Pi that adopted the claim and
then stopped without its shutdown handler reads as gone, even when another caller has since claimed
the lock. The fence completes once and reports one outcome: `cancelled`, `gone`, `adopted`, or
`unresolved`. A release or read failure is reported beside the outcome. A caller writes a hidden ask
as failed only for `cancelled` or `gone`, and reports from the record its locked read returns. After
`adopted` a lost launch reply waits on the child's process ID. For `unresolved` it leaves the record
`running` with the unconfirmed-stop detail, because the child may still adopt and answer. A valid
reply keeps the `hc wait` path, and `processState(pid)` alone confirms a stop after `hc kill`. The
fence reads the child and its adoption once, at completion, so no caller reports a released claim
while an adopted child runs.

When the caller completes a launch, it first renames the ticket to `<ticket>.cancelled`. Success
means no Pi from this launch can run: a shell that starts later fails its `mv` and exits 75 before
Pi, so the caller releases the claim at once, with no kill. `ENOENT` means the child took the
ticket, so the caller reads the process ID from the marker and follows the stop rule. Any other
rename error keeps the claim. `launchOutcomeDecision` drops the refused outcome and the
missing-executable text match: a launch is `created` or `notCreated`, and the ticket rename decides
the rest. The launch command runs without the caller's signal, and the caller checks that signal
just before dispatch. A 30 second timeout bounds the launch reply, and a timeout is `notCreated`.

Each caller sweeps the start folder right after its claim links. It holds the highest generation, so
every other ticket belongs to a gone claim. It cancels each unused ticket. For each started marker
it reads the process ID: `gone` deletes the marker and continues, even when the finished terminal
was removed with `hc rm`; `running` or `unknown` releases the caller's claim and refuses with a
message that names the process ID; a `.started` name without a valid process ID refuses with the
marker path to remove. The ticket name carries its lead's process ID: `<token>.lead.<leadPid>`, so
its markers read `<token>.lead.<leadPid>.started.<childPid>` and
`<token>.lead.<leadPid>.adopted.<childPid>`. After it takes the claim over, the architect renames
its marker from started to adopted. It never deletes it. The caller counts the child as adopted when
it has seen its own adopted marker, or when the live lock holder's process ID is its child's. A
different token or process ID in the lock is never its child's takeover. Adoption ends the fence:
after it, the caller never signals the child for the fence, and a hidden ask without a terminal
address waits on the child's process ID instead of cancelling it. The caller deletes the marker of a
child it reads gone only when the claim is released. The sweep refuses on an adopted marker whose
child is running or cannot be read, and names its process ID. It deletes an adopted marker only when
both its child and its lead are gone, and it leaves one whose child is gone while its lead lives, so
a lead always finds its own evidence.

The launch needs `sh` and `mv` on the machine that runs the terminal, and the ticket and Pi run in
the same checkout.

`ask` holds the claim until its hidden terminal ends. `open` waits up to 60 seconds for the
takeover. On that deadline, on a cancel before the takeover, or when the `ask` wait fails, the
caller stops the child by process ID and releases the claim once it is gone. When the caller does
not know the process or the process does not go away, it keeps the claim. A cancel after the
takeover leaves the architect running, because it already holds the lock and the user may be talking
to it.

In ask mode the architect also enforces its own deadline. Once it holds the lock, it arms a timer
from its ask record's `deadline`. At that deadline, a record that still reads `running` becomes
`timeout` with a detail, and the session shuts down. The lead publishes a fresh ask record under a
new UUID before dispatch, when no record exists yet; that initial publication is not a locked
update. Every later write to a hidden ask record goes through the per-ask lock and changes the
record only while it reads `running`; `sent`, `timeout`, and `failed` are final. The child's answer
handler moves `running` to `sent`; the child's deadline timer or the lead after its own deadline and
a confirmed stop moves `running` to `timeout`; the lead after a confirmed end without settlement,
the stale repair, or the child's shutdown moves `running` to `failed`; the lead alone may add an
unconfirmed-stop detail while the status is still `running`. The lead never writes a snapshot it
read earlier. After its wait returns it reads the record under the ask lock and reports from that
read: `timeout` gives the deadline result and `sent` gives the answer. The generic ended result
applies only when the lead itself moved `running` to `failed`. Shutdown clears the timer and awaits
an expiry already in progress before it settles the session's asks. Once shutdown starts, no
callback arms another timer. The deadline timer rearms when it fires before the saved deadline, as
after a clock change. The stale repair runs inside the same lock, checks that the status is still
`running`, and checks that the record's terminal is the address the `hc get` reply named as ended.
That reply is read before the lock, but the comparison uses the record the lock returns. A failed
`hc get` changes nothing. A Pi that hangs before session start never arms its deadline, so the
caller keeps the claim until the lead stops that terminal or ends its own session.

A Pi takes over its own claim while that claim is the highest generation and not released, even when
the lead that took it has exited. The generation link still picks one winner when another caller
claims at the same time. Refusing would end a valid architect whose only fault is that its lead
exited.

When Pi replaces the runtime in the same process, on any shutdown reason except `quit`, the
architect keeps the lock. It passes its lock token in `TAU_ARCHITECT_CLAIM` and its checkout root in
`TAU_ARCHITECT_HANDOFF_ROOT` to the next runtime. The next session start compares that root with the
checkout of its own working directory. In the same checkout, it adopts the token with the next
generation. So a reload, `/new`, `/resume`, or `/fork` never leaves the lock free while the process
keeps the session file open. In another checkout, which `/resume` can reach, it adopts and releases
the old checkout's lock first. Then it takes the new checkout's lock like any start. The start
decides, not the shutdown, because Pi gives the shutdown only the target session file. `/new` has
not written that file yet, and a working-directory override can contradict its header. On `quit`,
the lock is released before the process exits, and the adopted marker refuses new starts until the
kernel reads the process as gone.

### The lead's tab

The lead's tab holds only the lead on the left and the architect on the right. Workers open in
`<lead tab>-workers`, and `draft_review` opens tuicr in `<caller tab>-review`. For other terminals
that agents start, the rule is to open a new tab with `tab.new`.

By default, `handover start` creates a workspace for the checkout on this computer only when the
folder has none. It creates the workspace with Pi and its task in the first tab, so the user sees
the task instead of an empty shell. When a workspace for the folder exists and the caller names no
space, `handover start` refuses and names each matching workspace. A second workspace for one
checkout splits its work, and two leads can then edit the same checkout. The caller passes `space`
to open a `tab.new` tab in that workspace and leave its panes alone. The caller passes
`newSpace: true` to create another workspace on purpose. The two cannot be combined. Each handover
tab is named `lead: <name>`, after the short title of its work.

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
- A launch whose child took the ticket waits up to 10 seconds to stop it before it reports the
  error. A child that does not go away keeps the claim until the lead ends its session or a started
  Pi takes it over.
- A hidden Pi that hangs after it takes its ticket but before session start never arms its deadline.
  If its process does not go away, the caller keeps the claim until the lead stops that terminal or
  ends its session.
- A `pi` command that forks instead of exec'ing breaks the process-ID proof.
- A reused process ID keeps a start refused until that unrelated process ends.
- An adopted marker of a lead that died stays until the kernel reads both processes as gone. A
  reused process ID keeps it longer and refuses starts until that process ends.
- An architect that moves to another checkout through `/resume` leaves its adopted marker in the old
  checkout. That checkout refuses new architect starts, and names the process ID, until the process
  ends.
- A launch needs `sh` and `mv` on the machine that runs the terminal, and the ticket and Pi must run
  in the same checkout.

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

### Keep the claim on every ordinary launch failure

Release a claim only when a launch reports a nonzero exit. Rejected because the client result does
not prove the server will not create the terminal later, and the checkout would stay reserved after
every ordinary launch failure.

### Use a server-owned launch identifier

Ask the terminal server for a launch identifier whose cancellation or final query proves whether the
command ran. Rejected because it needs a herdr change, and the start ticket proves the same with a
rename the caller controls.

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
