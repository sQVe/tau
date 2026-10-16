# ADR 0114: Remind managers at half the context window to start a new session

**Date**: 2026-10-16\
**Status**: Accepted\
**Supersedes**: the reminder in
[ADR 0078 (Remind managers to compact and restore the worker ledger after each compaction)](./0078-remind-managers-to-compact-and-restore-the-worker-ledger.md)

## Context

The reminder fired once the context passed a fixed 200,000 tokens. Managers run on models with
different context windows, so a fixed count fires late on a small window and early on a large one.
Pi reports context use as a percentage of the current model's window.

A compaction keeps a summary and drops detail. A manager carries state through handover files and
Linear, so a new session that starts after a finished ticket can resume from them.

## Decision

Tau reminds the user once the context passes 50% of the model's context window, and the reminder
says to finish the current ticket, then start a new session. The threshold has no config key,
because no measurement supports another value that a user could pick. The reminder stays a notice:
it sends the model nothing and blocks nothing. It shows again only after a compaction or after the
context drops below the threshold, as before.

## Consequences

### Positive

- The reminder fires at the same share of the window on every model.
- The advice matches how managers already carry state between sessions.

### Negative

- 50% is a guess. No measurement shows where a manager's work starts to degrade.
- A user who prefers `/compact` gets advice that does not match that habit.

## Alternatives considered

### Keep the fixed 200,000 tokens

Keep the token count from ADR 0078. Rejected because it does not scale with the window of the
current model.

### A config key for the threshold

Let the user set the percentage in Tau config. Deferred because no user has asked for another value,
and the key would need validation and documentation.

### Block work past the threshold

Refuse tool calls or prompts once the context passes the threshold. Rejected because the threshold
is a guess, and a block would stop work in progress at a false alarm.
