# ADR 0151: Keep the file fence for architect launches

**Date**: 2026-11-24\
**Status**: Accepted

## Context

The architect launch fence
([ADR 0139](./0139-split-the-manager-role-into-a-lead-and-an-architect.md)) answers one question: is
any Pi still able to take this session file? It answers with a generation file, a one-shot start
ticket, pid markers, adoption, and a sweep. A kernel lock that the Pi process holds answers the same
question without those parts, because the kernel frees it when the last holder exits. A reused
process ID then cannot keep a lock alive, and no record has to be read to prove the holder lives.

Tau starts every architect through herdr, so the only place to take a lock before Pi runs is the
wrapper around the Pi argv. The choice is whether that lock replaces the fence or not.

## Decision

Keep the file fence. The architect launch path takes no OS lock and `flock` does not enter the
launch argv.

### What the lock cannot answer alone

An OS lock carries no owner. The owner record would be written after the lock is taken, either by
the wrapper before it execs Pi or by Pi at session start. A reader that finds the lock held and the
record stale has to report "starting", which is the state the fence already reports.

Ask settlement needs more than a live lock. It needs a name for the lock generation that may write,
because a reload keeps a session ID and a resume puts another session behind a terminal. The fence
publishes the record and the exclusion together in one link of a fully written file, so a record
always names a held generation. A lock taken before its record is written cannot do that. An ask
would key on a process ID and a session ID instead, and would need a rule for a stale record under a
held lock.

### What the lock would give up

An OS lock cannot be revoked. The wrapper takes the lock before Pi opens the session file, so an
unwanted launch is already fenced in. The fence instead renames the start ticket. A shell that has
not reached Pi then exits 75 without a kill, and a launch whose reply carried no terminal address
can still be cancelled. With an OS lock the only way to end an unwanted launch is to kill its
process, and a launch that reported no terminal address has no process to kill. The checkout then
stays reserved until that Pi exits.

### The wrapper must take the lock

`hc run` accepts argv, cwd, labels, parent, name, and a timeout. `herdr-app do` takes the argv of
the program it starts, with a name, a folder, a tab, a task, a machine, and a focus flag on
`space.new`, and a destination pane on `pane.split`. None of them takes a file descriptor, and none
takes an environment map: Tau passes environment values as `env NAME=value` in the argv. The lead
therefore cannot hand the Pi it starts a descriptor it already locked. The process that herdr starts
must take the lock itself, and `flock -F` does that in one exec: the launched terminal's pid is the
Pi pid.

### Why the fence stays

- macOS has no `flock(1)` and Node has no flock call, so a portable lock needs a bundled helper.
  macOS 15 added `lockf(1)`, but it takes fcntl locks, which a process drops when it closes any
  descriptor for the file, and it deletes the lock file on exit unless told not to.
- A lock probe is not read-only: it takes the lock and lets go, so a check that runs before a launch
  can make a real launch fail with the conflict code. The fence's check only reads the record and
  the holder's liveness, so a check never disturbs a launch.
- The one clear gain, a lock that stays held across `/reload`, is already covered. The session-file
  lock is kept across a reload, so a second Pi cannot write the session file while the architect
  retakes the launch lock.
- `flock` may always fail on some network file systems, while the fence uses `link` and `rename`.

## Evidence

A prototype on this branch runs each behaviour against real processes and prints the result. Run it
with `node scripts/osLockSpike.ts`. Its output on util-linux 2.42.4 and Node 24.22.1:

```text
secondHolder: secondExitCode=75
holderOutlivesParent: holderAlive=true state=held
everyHolderGone: before=held after=free
detachedChild: parentExitCode=0 state=held
wrapperAcrossExec: secondExitCode=75 stateAfterKillingHolder=free
supervisorWithoutFork: stateAfterSupervisorKilled=held stateAfterGroupKilled=free
```

`wrapperAcrossExec` is the case that matters for a launch. The wrapper takes the lock and execs a
long-running child. A second wrapper fails with 75 while that child runs, and killing the exec'd
process frees the lock, which shows that the child itself holds it rather than a wrapper around it.

The lock also survives the real launch path and a reload:

- A Pi started through `hc run` under the wrapper held the lock. `hc get` reported the Pi process as
  both the terminal pid and the foreground pid, a holder from outside the terminal got 75, and
  `hc kill` freed the lock.
- A Pi under the wrapper reloaded in the same process: an extension saw `session_shutdown` reason
  `reload` and `session_start` reason `reload` with the same pid, and the lock stayed held until the
  process was killed. A visible Pi's `/reload` was not typed here, because typing into a terminal is
  blocked; the RPC run uses the same in-process reload.

When the wrapper cannot take the lock it exits 75 and prints nothing. Through `hc run` without
`--bg`, the launch reply carries `ended: true` and `exit_code: 75`. A `--bg` launch leaves a
finished terminal with an empty screen, and a herdr launch reply carries no exit code at all, so a
caller that does not check before launching reports a dead pane instead of a refusal. Keeping the
fence avoids this case, because the launch is refused before it starts. A replacement would have to
print the reason from the wrapper, since the pane is the only place a visible launch can report it.

Sources for the platform claims: the local `flock(1)` page (util-linux 2.42.4) for `-F`, `-E`,
sysexits codes, and the network file system limit;
[nodejs/node#122](https://github.com/nodejs/node/issues/122) for Node's refusal to add a flock API;
[Homebrew brew#18516](https://github.com/Homebrew/brew/pull/18516) and the
[flock formula](https://formulae.brew.sh/formula/flock) for macOS shipping no `flock(1)` and `lockf`
only from macOS 15. macOS was not available here, so those claims rest on the sources.

## Consequences

### Positive

- A caller refuses before it launches, so the user reads "the architect is already running" instead
  of finding a dead pane.
- A launch that has not reached Pi can be cancelled without a kill, including one whose terminal
  address was lost.
- The owner record and the exclusion are published together, so a held lock always names the session
  that may write an ask.
- No new executable enters the launch path. The fence needs `sh` and `mv`; an OS lock would need
  `flock` from util-linux, which macOS does not ship.

### Negative

- The markers, adoption, and sweep stay, though they answer a question the kernel could answer.
- The fence keeps its pid-based liveness, so a reused process ID errs toward refusal and a start
  that cannot be stopped keeps its claim.
- A reload releases and retakes the architect lock. The session-file lock covers the window, so no
  second Pi writes the file, but the launch lock alone does not.

## Alternatives considered

### Take the lock in the launch wrapper

Wrap the Pi argv in `flock -F -n -E 75 <lock> <argv>` and delete the ticket, markers, adoption,
sweep, and stop proof. This works and removes most of the fence. Rejected because it needs a `flock`
command that macOS does not ship, it makes every liveness check a lock attempt, and it cannot revoke
a launch that reported no terminal address. It also keeps the owner record, so the simplification is
smaller than it looks.

### Hold the lock in a supervisor that outlives Pi

Run the command under a process that holds the lock and waits for Pi. Rejected because the
descriptor is inherited by the command anyway: the lock already survives the supervisor's death
while the command lives, as the prototype shows. The supervisor adds a process to find and kill
without adding a guarantee.

### Pass the locked descriptor through the herdr CLI

Open and lock the file in the lead, then give the descriptor to the started Pi. Rejected because
`hc run` and `herdr-app do` accept no file descriptor. It would need a herdr change, and it would
still leave the record and the revocation questions open.
