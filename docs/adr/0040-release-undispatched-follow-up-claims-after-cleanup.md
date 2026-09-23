# ADR 0040: Release undispatched follow-up claims after confirmed cleanup

- Status: Proposed
- Date: 2026-09-23

## Context

A failed start can leave no worker and still consume the predecessor's only follow-up claim. Keeping
that claim cannot prevent duplicate work when the parent never dispatched the assignment. A start
error alone does not prove absence: the worker may have launched before the response failed.

## Options considered

- Keep every claim permanently. This avoids reclaim races but blocks conversations after confirmed
  pre-dispatch failures.
- Release claims after a start error or a timeout. Neither proves that the worker stopped.
- Release the owning controller's claim after confirmed cleanup, only without dispatch, acceptance,
  or report evidence. This permits retries without treating uncertain delivery as rejection.

## Decision

Allow the owning controller to release a follow-up claim after confirmed cleanup when no assignment
was dispatched, accepted, or reported. Preserve the failed task and its cleanup evidence. Do not
release another attempt's claim or reclaim by age. A new attempt must pass native-session and
live-writer validation again.

This replaces the permanent-claim rule in
[ADR 0030](./0030-claim-native-follow-ups-before-opening.md) for this bounded case. Keep pre-opening
claims and all other follow-up restrictions.

## Tradeoffs

- Confirmed pre-dispatch failures do not permanently block a conversation.
- Uncertain cleanup and dispatched assignments still retain their claims.
- Cost: old unconfirmed tasks still need manual investigation. Missing evidence is not proof of
  absence, and this decision does not authorize rewriting their cleanup records.
