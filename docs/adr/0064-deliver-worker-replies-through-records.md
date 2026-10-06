# ADR 0064: Deliver worker replies through records

**Date**: 2026-09-28\
**Status**: Accepted\
**Related**: [ADR 0028 (Keep worker control in the parent)](./0028-keep-worker-control-in-the-parent.md),
[ADR 0059 (Run each Pi worker as its pane's own process)](./0059-run-each-pi-worker-as-its-panes-own-process.md)

## Context

A worker that asks the parent a question waits for a reply. The parent saved the reply and then
typed it into the worker's pane. This was the last place the parent sent terminal input to a worker.

When a pane write failed or was not confirmed, the parent could not tell whether the worker saw the
reply, so the reply receipt carried a delivery state the parent had to interpret. The worker already
receives its task by watching its record directory.

## Decision

The parent only saves the reply record. While a question is pending, the worker watches for the
reply and sends it to its own session as a user message, the same way it receives its task. It saves
its acknowledgement when that message reaches its input hook. A reply then needs no herdr call, and
the worker's acknowledgement proves it took the reply.

### Delivery rules

- The acknowledgement record is the only proof that the worker took the reply, so it is saved only
  once the session accepted the message.
- The worker delivers the reply only after the question turn has settled.
- The parent sends no terminal input to a worker.

## Consequences

### Positive

- A reply needs no herdr call, so a restarted parent can reply as long as the worker still waits.
- The reply receipt has no delivery state to interpret.

### Negative

- The worker notices a reply on its next watch tick, up to a second after the parent saves it.

## Alternatives considered

### Type into the pane

Keep typing the reply into the pane. Rejected because it depends on herdr accepting input at the
right pane, and it never proves the worker read the reply.
