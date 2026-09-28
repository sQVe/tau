# ADR 0064: Deliver worker replies through records

- Status: Accepted
- Date: 2026-09-28

## Context

A worker that asks the parent a question waits for a reply. The parent saved the reply in the task's
record directory, then typed a marker line into the worker's pane with `herdr agent prompt`, and the
worker matched that exact text. This was the last place the parent sent terminal input to a worker.
A failed or unconfirmed pane write left the parent unsure whether the worker saw the reply, so the
receipt carried a delivery state the parent had to interpret. The worker already receives its task
by watching the record directory.

## Options considered

- Keep typing into the pane. It works, but it depends on herdr accepting input at the right pane and
  leaves a delivery state that never proves the worker read the reply.
- Let the worker read the reply from the record directory while its question is pending, the same
  way it receives its task.

## Decision

The parent only saves the reply record. While a question is pending, the worker watches for the
reply, saves its acknowledgement, and sends the reply to its own session as a user message.

- The acknowledgement record is the only proof that the worker took the reply.
- The worker delivers the reply only after the question turn has settled.
- The parent sends no terminal input to a worker.

## Tradeoffs

- A reply needs no herdr call, so a restarted parent can reply as long as the worker still waits.
- The reply receipt has no delivery state to interpret.
- Cost: the worker notices a reply on its next watch tick, up to a second after the parent saves it.

## See also

- [ADR 0028: Keep worker control in the parent](./0028-keep-worker-control-in-the-parent.md)
- [ADR 0059: Run each Pi worker as its pane's own process](./0059-run-each-pi-worker-as-its-panes-own-process.md)
