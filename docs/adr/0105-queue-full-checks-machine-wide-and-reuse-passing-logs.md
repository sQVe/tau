# ADR 0105: Queue full checks machine-wide and reuse passing logs

**Date**: 2026-10-12\
**Status**: Accepted\
**Related**: [ADR 0053 (Version each saved record format)](./0053-version-each-saved-record-format.md),
[ADR 0057 (Enforce pure decision modules from a registry)](./0057-enforce-pure-decision-modules-from-a-registry.md)

## Context

Several workers in different checkouts run the same full check at once. The runs compete for CPU and
slow each other down. Workers also rerun a check on a state that already passed.

## Decision

The `full_check` tool runs one full check at a time on the machine, and returns a saved passing log
when the state has not changed.

The tool takes a lock under the agent directory and waits while another checkout holds it. Each
passing log gets a versioned record next to it in `.tau/checks`. The record holds the head commit,
the base commit, the configured `argv`, and a hash of the tracked changes against `HEAD` and of the
untracked files Git does not ignore. A later call with equal values returns that log without running
the command. It checks before waiting and again after taking the lock, since another session may
have saved a matching log while this one waited.

The tool reads the identity before and after the run. It saves a record only when the command passed
and both identities are equal, so an edit during the run never gives a reusable log. A missing or
malformed record is not a match. The reuse rule is a pure function that takes the records and the
current identity as facts.

## Consequences

### Positive

- Concurrent workers do not slow each other down.
- A second call for an unchanged state costs no run.

### Negative

- A check that reads state outside the checkout, such as the network or a database, can pass again
  with different results. Reuse hides that change.
- A worker waits for any other checkout's check, even for an unrelated repository.

## Alternatives considered

### Reuse a log by commit only

Match on the head commit alone. Rejected because uncommitted edits and a changed base or command
would return a log for a different state.

### Lock per repository

Queue only checks of the same repository. Rejected because the CPU contention is machine-wide, not
per repository.
