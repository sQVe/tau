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

Tau gives each worker its own scratch folder at
`<agentDirectory>/tmp/ws/<first 8 hex of the assignment ID>`, outside `/tmp`, and sets it as the
worker's `TMPDIR`. The short path keeps Chrome's `SingletonSocket` under the 103-byte Unix socket
limit. A liveness sweep removes the folder after the worker ended. The worker never removes it. The
launch creates the folder right before `hc run`, after its slower reads, and the worker creates it
again at start, in case a sweep removed it while `hc run` was slow. A launch that fails definitely
removes the scratch folder only when that launch created it. A folder that already existed belongs
to another assignment with the same short ID, and only the sweep removes it.

The sweep runs after each worker scan and after each launch starts its worker, in any manager. The
launch does not wait for it. A manager that exited is covered by the next launch or scan from any
other manager.

The sweep reads `hc ls --all`, then `hc get` for each live worker terminal, at most 4 at a time,
because the list carries no labels. Each `hc get` is stopped at 10 seconds, and a stopped read
counts as a failed read. Pi sends SIGTERM at 10 seconds and SIGKILL 5 seconds later if the process
lives, so a read ends within 10 seconds plus that grace. A finished terminal needs no read, since it
protects nothing. A live terminal whose name is not a worker name needs no read either. It removes a
scratch folder only when no running worker has its assignment's short form. A folder that no
terminal names must also be at least a minute old. The minute protects a launch that created its
folder but has not started the worker yet. A worker that is starting counts as running, so a launch
never removes its own folders.

The sweep removes a package snapshot only when no running worker has named it for 24 hours. The
clock starts at the first sweep that sees no running worker name the snapshot. That sweep writes a
`.tau-unused-since` marker in the snapshot, and the marker's modification time is the start. A sweep
that sees a running worker name the snapshot removes the marker. A launch's own sweep also removes
the marker of its starting worker's snapshot when `hc ls` fails, and marks and removes nothing else.
Marker changes use the same redirected-root guard as removals and never follow a link at the marker
path. A follow-up reuses the snapshot of its source assignment, and a follow-up is the only reader
that starts after a worker ended. The 24-hour window protects a follow-up that another manager or a
scan has not yet seen as running.

The sweep takes one lock at `<agentDirectory>/.tau-worker-folder-sweep.lock`, shared by every
manager that sweeps the same agent directory. It takes the lock before it reads the `hc` listing,
the folders, and the markers, and holds it until it has written every marker and removed every
folder, including the fallback that keeps everything when the listing fails. Evidence and effects
must come from one view: a sweep that read a snapshot as unused before a launch cleared its marker
would otherwise write that stale marker back after the launch. A sweep that finds the lock held
waits for it, because skipping its launch sweep could lose the clear. The clock is sampled once,
after the lock is taken, so a wait never backdates a new marker. A launch does not wait: it starts
its sweep without awaiting it. A launch's sweep carries the exact terminal address of the worker it
started. The lock does not grant claims in the order they were submitted, so an end scan can take
the lock and write the unused marker before an earlier launch sweep runs. The launch sweep therefore
drops its starting fact when the fresh listing or a terminal read reports that exact address as
finished. A live worker that names the snapshot still protects it, and unread, missing, or unrelated
evidence leaves the starting fact in place. A lock failure reaches the scan's error handler or the
launch's catch, like any other sweep failure.

A follow-up that reuses a package snapshot waits for the sweep lock before it starts. Under the lock
it checks the package paths again, clears the snapshot's old marker with the same guards, and keeps
the lock through the terminal request and its reconciliation. It releases the lock before it starts
its sweep and does not await the sweep. The wait uses the request's cancellation signal. If a
definite start failure follows the clear, the follow-up restores the old marker time. If the worker
may have started, it leaves the marker cleared. A release error after a confirmed start keeps the
started result and reports a warning. This narrows the old limitation: a manager that shares the
lock cannot start a follow-up on a snapshot that a sweep removes between validation and listing,
because the package path check runs again under the lock. A follow-up of a manager that does not
share the lock, on a snapshot whose marker is already older than 24 hours, can still lose that
snapshot.

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
- A follow-up started more than 24 hours after the first sweep that saw its source snapshot unused
  can fail, because the sweep may have removed the snapshot.
- A snapshot stays for one sweep longer than 24 hours after its last user ended, because the clock
  starts at the first sweep that sees it unused.
- A sweep adds one `hc ls` read and one `hc get` per live worker terminal to each scan and launch. A
  slow terminal delays the sweep by up to 10 seconds plus the kill grace.
- A sweep waits for another sweep of the same agent directory, so its own reads and effects can be
  delayed by that sweep's terminal reads.
- The launch grace applies only when no terminal names the folder, including when a finish appears
  only in the list.
- An agent directory longer than 46 bytes still makes Chrome's socket path too long, because
  `/tmp/ws/` and the 8-byte folder name leave 46 bytes for the agent directory.
- Two assignments whose IDs start with the same 8 hex digits share one scratch folder. The sweep
  keeps it while either worker runs, and a failed launch removes it only when that launch created
  it. If both launches start at the same moment and the one that created the folder fails, it
  removes the folder. The other worker creates it again when it starts, but it loses files it wrote
  before then.
- Tests cannot use the worker's `TMPDIR`, because it sits inside the real HOME and makes Unix socket
  paths too long. In a worker session the test run sets `TMPDIR` to `/tmp`, and each test removes
  its own folders as today.

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

### Put the scratch root under `/tmp`

A root at `/tmp/tau-<uid>/<agent-directory hash>/` would fit an agent directory of any length.
Rejected because it needs a per-agent-directory key, so a test sweep with a fake `hc` would remove
real workers' folders. It needs owner and mode checks on a shared world-writable parent. On macOS,
`/tmp` resolves to `/private/tmp`, which makes the canonical path 66 bytes or more. It also moves
worker files onto `/tmp`, which is RAM on tmpfs systems. Revisit it only if a real agent directory
is longer than 46 bytes.
