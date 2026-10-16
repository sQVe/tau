# ADR 0105: Queue full checks per repository and reuse passing logs

**Date**: 2026-10-12\
**Status**: Accepted\
**Related**: [ADR 0053 (Version each saved record format)](./0053-version-each-saved-record-format.md),
[ADR 0057 (Enforce pure decision modules from a registry)](./0057-enforce-pure-decision-modules-from-a-registry.md)

## Context

Several workers in different checkouts run the same full check at once. The runs compete for CPU and
for shared resources, such as Docker ports, and fail or slow each other down. Workers also rerun a
check on a state that already passed.

## Decision

The `full_check` tool runs one full check at a time for each repository, and returns a saved passing
log when the state has not changed. Checks of different repositories run at once.

The tool takes a lock for the repository under the agent directory and waits while another checkout
of that repository holds it. The lock file name comes from the lowercase `owner/name`, encoded so it
holds no path separator. Two checks of one repository share resources such as Docker ports, and two
at once fail with "Docker could not bind a port: address already in use".

The lock files live in their own `full-check` directory. A Pi session that started before this
change still uses the single machine-wide file `full-check.lock.<n>` and never reads the new
directory. The new code never reads the old file. Until every Pi session restarts, a check on old
code and a check on new code of the same repository can run at once. Each passing log gets a
versioned record next to it in `.tau/checks`. The record holds the head commit, the base commit, the
configured `argv`, and a hash of the tracked changes against `HEAD` and of the untracked files Git
does not ignore. A later call with equal values returns that log without running the command. It
checks before waiting and again after taking the lock, since another session may have saved a
matching log while this one waited.

The tool reads the identity before and after the run. It saves a record only when the command passed
and both identities are equal, so an edit during the run never gives a reusable log. A missing or
malformed record is not a match. The reuse rule is a pure function that takes the records and the
current identity as facts.

## Consequences

### Positive

- Concurrent workers in one repository do not collide on shared resources.
- A short check of one repository does not wait behind a long check of another.
- A second call for an unchanged state costs no run.

### Negative

- A check that reads state outside the checkout, such as the network or a database, can pass again
  with different results. Reuse hides that change.
- Checks of different repositories compete for CPU. No limit applies across repositories.
- During the switch, old and new sessions do not exclude each other.

## Alternatives considered

### Reuse a log by commit only

Match on the head commit alone. Rejected because uncommitted edits and a changed base or command
would return a log for a different state.

### Machine-wide lock

Queue every check on the machine behind one lock. This was the first decision. Rejected because the
wait cost more than the contention it removed. On 2026-10-16, 21 full checks ran between 12:00 and
13:33 UTC. The lock handed over within 0 to 2 seconds. Tau, phi, and zeta checks (6 seconds to 3
minutes) waited behind platform checks (220 to 320 seconds), which were 13 of the 21 runs. The CPU
contention between repositories was smaller than that wait.

### A machine-wide limit on concurrent checks

Allow a fixed number of checks at once across all repositories. Deferred until check timeouts caused
by CPU contention show up.
