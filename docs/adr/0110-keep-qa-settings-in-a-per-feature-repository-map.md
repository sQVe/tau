# ADR 0110: Keep QA settings in a per-feature repository map

**Date**: 2026-10-14\
**Status**: Accepted\
**Extends**: [ADR 0095 (Keep repository routing in tracker config)](./0095-keep-repository-routing-in-tracker-config.md)\
**Related**:
[ADR 0099 (Warn on unknown config keys and fail only the entry in use)](./0099-warn-on-unknown-config-keys-and-fail-only-the-entry-in-use.md)

## Context

A `qa` worker needs the app URL of the worktree's dev server, a test account, and a rule on whether
it may create data. Managers asked the user for these on every run, which slowed the pull request
flow. The values differ per repository, and the test account is a secret.

## Decision

Keep QA settings under `qa.repositories` in the user config, keyed by the `origin` remote's
`owner/name`, as `fullCheck.repositories` does.

Each entry holds three optional fields: `urlCommand`, `testAccountCommand`, and `dataWrites`, which
defaults to false. Only the user file may set `qa`, because the commands run on the user's machine.
Unknown keys warn once, a bad entry fails only `qa` launches for its own repository, and one helper
matches the repository key for both `qa` and `fullCheck`.

Tau runs `urlCommand` in the worktree when a `qa` launch has no `url`, and passes its output to the
existing `url` answer check. Tau never runs `testAccountCommand`. The brief tells the worker to run
it, so the secret stays out of the manager context and the config holds no password.

## Consequences

### Positive

- Managers stop asking for the URL and the account.
- The config file holds commands, not secrets.
- One URL check serves explicit and configured URLs.

### Negative

- A user must write one entry per repository.
- A slow or failing `urlCommand` refuses the launch.

## Alternatives considered

### Group settings under `repositories[owner/name]`

Rejected for the reason in [ADR 0095](./0095-keep-repository-routing-in-tracker-config.md): it makes
users rewrite working config without a gain.

### Store the test account in the config

Rejected because worker records and the manager context would hold the password.
