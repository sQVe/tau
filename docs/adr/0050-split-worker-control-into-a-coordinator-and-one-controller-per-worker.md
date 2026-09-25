# ADR 0050: Split worker control into a coordinator and one controller per worker

- Status: Accepted
- Date: 2026-09-25

## Context

- `WorkerController` held every worker concern in one 1,981-line class: registry, capacity, launch,
  follow-up, status, replies, polling, timeouts, cleanup, notifications, recovery, and widget data.
- Nearly every subagents change touched it, and parallel branches collided there.
- Pi and generic steps interleaved through `isGenericLoadout` branches inside shared methods.
- The worker handle had 22 ungrouped fields.

## Options considered

- Keep one controller and split only its helpers into modules. Changes to one worker's lifecycle
  would still edit the class that holds global state.
- Add a harness interface with a Pi and a generic implementation.
  [ADR 0033](./0033-use-one-generic-native-worker-workflow.md) rejects per-harness adapters, and the
  Pi and generic paths share most steps.
- Serialize each worker's operations through a per-task queue. No same-worker race has shown up, and
  cancellation would have to bypass the queue to abort in-flight work.

## Decision

Split worker control along the line between global state and one worker's lifecycle.

### Coordinator

`WorkerController` keeps what spans workers: the registry, capacity, launch allocation, follow-up
checks, placement, status reads, resume, cancellation entry, and shutdown. It passes one shared
`TaskContext` to every per-task controller. That context holds only the client, notifier, placement,
lifetime signal, and closed, ownership, and capacity-release callbacks.

### Per-task controller

`TaskController` owns one worker's handle and its startup, dispatch, replies, polling, stop, and
cleanup. The handle groups its fields by concern (identity, startup, observation, cleanup) rather
than modeling phases as a union.

### Generic steps

Generic-only steps live together as plain functions in `controller/genericWorker.ts`. Shared
`TaskController` methods route to them with one check each. There is no harness interface.

### No per-task queue

Operations on one worker are not serialized. Add a queue only when a same-worker race appears, and
let cancellation abort in-flight work outside it.

## Tradeoffs

- A change to one worker's lifecycle touches `TaskController` or the generic steps, not the
  coordinator.
- The tests still drive the public `WorkerController` API, so the split needs no test changes.
- Cost: generic steps call back into `TaskController`, so a lifecycle transition can span two files.
- Cost: `TaskController` exposes the members the generic steps need, such as `stop`, `poll`, and
  `notifySnapshot`.

## See also

- [ADR 0028: Keep worker control in the parent](./0028-keep-worker-control-in-the-parent.md)
- [ADR 0033: Use one generic native worker workflow](./0033-use-one-generic-native-worker-workflow.md)
- [ADR 0043: Own only the worker guarantees herdr lacks](./0043-own-only-the-worker-guarantees-herdr-lacks.md)
