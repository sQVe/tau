# ADR 0143: Give workers a Tau-owned TMPDIR, removed by a liveness sweep

**Date**: 2026-11-19\
**Status**: Accepted\
**Related**: [ADR 0125 (Run workers as hc children with one assignment file each)](./0125-run-workers-as-hc-children-with-assignment-files.md)

## Context

A worker writes temporary files while it runs. When it uses the system temporary folder, those files
fill `/tmp`, and a worker that crashes or is killed cannot remove them. Package snapshots had the
same problem: Tau kept each one after its worker ended, because a follow-up may reuse it.

The worker itself cannot be trusted to clean up. A worker that reports, times out, is cancelled, or
crashes ends in different ways, and a manager that exited cannot clean up for the workers it
started.

## Decision

Tau gives each worker its own scratch folder under the agent directory, outside `/tmp`, and sets it
as the worker's `TMPDIR`. A liveness sweep removes the folder after the worker ended. The worker
never removes it.

The sweep runs after each worker scan and after each launch starts its worker, in any manager. The
launch does not wait for it. A manager that exited is covered by the next launch or scan from any
other manager.

The sweep reads `hc ls --all`, then `hc get` for each live worker terminal, at most 4 at a time,
because the list carries no labels. A finished terminal needs no read, since it protects nothing. A
live terminal whose name is not a worker name needs no read either. It removes a scratch folder only
when no running worker has its assignment ID. A folder that no terminal names must also be at least
a minute old. The minute protects a launch that created its folder but has not started the worker
yet. A worker that is starting counts as running, so a launch never removes its own folders.

The sweep removes a package snapshot only when no running worker names it and it is at least 24
hours old. A follow-up reuses the snapshot of its source assignment, and a follow-up is the only
reader that starts after a worker ended. The 24-hour window protects a follow-up that another
manager or a scan has not yet seen as running. The sweep takes no lock. One race stays as a known
limit: a follow-up of another manager that starts between its validation and the `hc` listing, on a
snapshot already older than 24 hours, can lose that snapshot.

The sweep fails closed. It removes nothing when the `hc` list cannot be read. When `hc get` fails
for a live terminal, the sweep keeps every snapshot and the scratch folders that terminal may own.
The worker name gives the start of its assignment ID, so the sweep keeps the folders that start with
it. When the name gives no start, the sweep keeps every scratch folder. The scan reports the failed
read. It keeps every snapshot when the assignment of a running worker is missing or malformed, since
that worker may use any snapshot. A removal goes through one guard that refuses a redirected root
and a folder name that is a path.

A sweep failure never fails a launch or a scan. The scan reports each error. The launch stays silent
and the next scan reports it. A folder skipped for the launch grace is removed by the next sweep, so
no timer is needed.

## Consequences

### Positive

- A worker that reports, times out, is cancelled, or crashes leaves no scratch folder.
- Worker temporary files stay out of `/tmp`.
- No process needs to stay alive to clean up.

### Negative

- A scratch folder lives until the next scan or launch after its worker ends.
- A follow-up started more than 24 hours after its source worker ended can fail, because the sweep
  may have removed the snapshot.
- A sweep adds one `hc ls` read and one `hc get` per live worker terminal to each scan and launch.
- A folder named by a finished worker, and younger than a minute, stays until the next sweep.

## Alternatives considered

### Let the worker remove its own folder

The worker removes its scratch folder when it exits. Rejected because a crashed or killed worker
never runs the cleanup, and that is the case that fills the disk.

### Remove folders with a timer

Each launch schedules a delayed removal. Rejected because the timer dies with its manager, and a
fixed delay either removes a folder a long worker still uses or keeps it long after the worker
ended.

### Keep every package snapshot

Keep the current rule that an ended worker keeps its snapshot. Rejected because snapshots grow
without bound, and one snapshot holds a full copy of each profile package.
