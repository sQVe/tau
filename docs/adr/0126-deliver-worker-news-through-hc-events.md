# ADR 0126: Deliver worker news through `hc` events, not typed pane input

**Date**: 2026-11-03\
**Status**: Accepted\
**Related**: [ADR 0125 (Run workers as hc children with one assignment file each)](./0125-run-workers-as-hc-children-with-assignment-files.md),
[ADR 0120 (Capability modules with an enforced import table)](./0120-capability-modules-with-an-enforced-import-table.md)

## Context

A worker told its manager about a report or a question by running `hc send` at the manager terminal.
The manager started a worker scan when that text appeared in its `input` handler. `hc` also typed
its own `<hc>... exited</hc>` note into the manager pane, because Tau started workers without
`no_notify`. Typed worker text mixed with what the user was typing.

## Decision

Worker news reaches the manager through `hc`'s event stream, not typed input. A report sets a
`tau.report` label, and a question sets a `tau.question` label, on the worker's own terminal. The
manager process subscribes with `events.subscribe` and `children_of` its own terminal over a
long-lived `hc connect`. A child labels change, a child finished event, or a missed snapshot starts
at most one pending worker scan. Heartbeats and every other event type do nothing. After an exit or
error, the subscription retries for the whole session with a delay capped at 45 seconds, and stops
at session shutdown. One lasting failure shows one notice per outage. Subscription failures go to
`ui.notify`, never to a Pi message.

### Delivery

Tau starts workers with `no_notify`, so `hc` types no exit note. Only a report, a question, or one
short "ended without a report" message reaches the session. The ended message appears once for a
finished worker that has a saved assignment, no report, and no "ended at its deadline" message. Tau
puts no event payload, screen, or label dump in message content.

An arriving message wakes an idle manager and steers a running one. That wake rule lives in one
shared module that both the worker delivery and mergeWatch use.

## Consequences

### Positive

- Typed worker news no longer mixes with the user's typing.
- The manager learns about a report or a question from the same state the user sees with `hc ls`.

### Negative

- A lost event subscription delays a report until it reconnects or until session start.
- A finished worker without a report produces one extra message.

## Alternatives considered

### Keep `hc send` notes and the input trigger

Rejected because the typed note mixes with the user's input, and the input trigger reads text that
the user may also type.

### Send one Pi message per hc event

Rejected because events are frequent, and only a report or a question is news to the session. An
event starts a scan; the scan decides what to show.

### Poll `hc ls` on a timer

Rejected because it adds a second source of worker state and a delay, while the event stream already
reports the label and finish changes Tau needs.
