# ADR 0076: Give browser workers one shared set of browser rules

**Date**: 2026-10-01\
**Status**: Accepted\
**Related**: [ADR 0067 (Give each worker profile one loadout of tools, skills, instruction sets, and packages)](./0067-give-workers-only-their-profile-tools-and-skills.md),
[Vision](../vision.md)

## Context

The user signs in to sites once in an agent-only Chrome profile. The browser package opens a copy of
that profile, but only for automatic sessions without an explicit profile.

Agents used fresh sessions, passed their own profile folders, or signed in inside the browser. A
login inside the agent browser never reaches the Chrome profile it copied, so other and later
workers did not get it, and the user signed in again and again.

Nothing told agents how to keep the configured profile. The rules apply to every worker that uses
the browser, and the manager should not pay for them on each turn.

## Decision

Browser workers load one shared `browser` instruction set that holds the login rules, so each
browser worker follows them from its first browser call. Only workers that load the set receive the
rules.

### Logins

- Workers keep the configured profile: automatic sessions, no explicit profile or browser path
  unless the task names another account or the user approved a persistent profile, and no new
  profile folders without the user's approval.
- On a login wall, a worker signs in only with credentials the task gives it, such as a test
  account. Otherwise it stops and asks.
- The manager then asks the user to sign in once in Chrome on the agent profile and close it. It
  then cancels the waiting worker and starts a new one, which copies the updated profile.
- `browser.loginCommand` in the user `tau.json` names the command that opens that profile. With it,
  the manager asks the user to run that exact command. Without it, the manager names no command.
  Only the user file may set it, because the manager asks the user to run it.

## Consequences

### Positive

- Each worker is its own root Pi session, so it gets its own browser and a fresh copy of the
  profile. Tau does not set `PI_SUBAGENT_ROOT_SESSION_ID`. If workers shared the manager's root,
  they would share one browser, and "sign in, then start a new worker" would stop working.
- Logins made once in the agent profile reach every later browser worker.
- The manager's prompt does not grow with the browser rules.

### Negative

- A login needs the user, and a running worker cannot pick it up; the manager starts a new one.
- The manager loses the browser once the user removes the package from their own settings. Until
  then, it may still use the browser itself without these rules.

## Alternatives considered

### Copy the rules into each profile

Copy the rules into each profile body that uses the browser. Rejected because the copies drift
apart.

### Skill

Put the rules in a skill. Rejected because a worker loads a skill only when it decides to, and the
rules must apply from the first browser call.

### Default sets

Add the rules to the default sets. Rejected because profiles without the browser would pay for them
on every turn.
