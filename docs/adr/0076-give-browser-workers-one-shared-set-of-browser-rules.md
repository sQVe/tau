# ADR 0076: Give browser workers one shared set of browser rules

- Status: Accepted
- Date: 2026-10-01
- Supersedes: the set names, `qa` sets, and delivery order in
  [ADR 0068](./0068-load-only-the-instruction-sets-each-worker-profile-needs.md)

## Context

- The user signs in to sites once in an agent-only Chrome profile. The browser package opens a copy
  of that profile, but only for automatic sessions without an explicit profile.
- Agents used fresh sessions, passed their own profile folders, or signed in inside the browser. A
  login inside the agent browser never reaches the Chrome profile it copied, so other and later
  workers did not get it, and the user signed in again and again.
- Browser work other than QA had no profile, so the manager used the browser itself, and nothing
  told any agent how to keep the configured profile.
- The rules apply to every profile that uses the browser, and the manager should not pay for them on
  each turn.

## Options considered

- Copy the rules into each profile body that uses the browser. Rejected: the copies drift apart.
- Put the rules in a skill. Rejected: a worker loads a skill only when it decides to, and the rules
  must apply from the first browser call.
- Add a `browser` instruction set that profiles opt into with `instruction-sets:`. Chosen: the rules
  live in one file, only workers that name the set receive them, and a follow-up keeps them.
- Add the rules to the default sets. Rejected: profiles without the browser would pay for them on
  every turn.

## Decision

Browser work runs in workers that load the `browser` instruction set, not in the manager.

### Profiles

- The bundled `browser` profile does the browser work the manager delegates, such as lookups, forms,
  page checks, and screenshots. It loads the browser package and does not edit the worktree.
- `instruction-sets:` takes `writing`, `coding`, `workflow`, and `browser`. An unknown name makes
  the profile invalid.
- Profiles without `instruction-sets:` still get `writing`, `coding`, and `workflow`, not `browser`.
- The bundled `browser` and `qa` profiles load `writing`, `workflow`, and `browser`.
- The `browser` set has no Pi extension, so the manager never appends it. A worker appends its sets
  in the order writing, coding, workflow, browser.

### Logins

- Workers keep the configured profile: automatic sessions, no explicit profile or browser path
  unless the task names another account, and no new profile folders without the user's approval.
- On a login wall, a worker signs in only with credentials the task gives it, such as a test
  account. Otherwise it stops and asks.
- The manager then asks the user to sign in once in Chrome on the agent profile and close it, and
  starts a new worker, which copies the updated profile.
- `browser.loginCommand` in the user `tau.json` names the command that opens that profile. With it,
  the manager asks the user to run that exact command. Without it, the manager names no command.
  Only the user file may set it, because the manager asks the user to run it.

### Records

- Task record format 7 allows the `browser` name. Tasks saved in formats 5 and 6 keep the sets they
  saved. Tasks saved in earlier formats get `writing`, `coding`, and `workflow`, which is what they
  had.

## Tradeoffs

- Each worker is its own root Pi session, so it gets its own browser and a fresh copy of the
  profile. Tau does not set `PI_SUBAGENT_ROOT_SESSION_ID`. If workers shared the manager's root,
  they would share one browser, and "sign in, then start a new worker" would stop working.

- Logins made once in the agent profile reach every later browser worker.
- The manager's prompt does not grow with the browser rules.
- Cost: a login needs the user, and a running worker cannot pick it up; the manager starts a new
  one.
- Cost: the manager loses the browser once the user removes the package from their own settings.
  Until then, it may still use the browser itself without these rules.

## See also

- [ADR 0053: Version each saved record format](./0053-version-each-saved-record-format.md)
- [ADR 0068: Load only the instruction sets each worker profile needs](./0068-load-only-the-instruction-sets-each-worker-profile-needs.md)
- [ADR 0069: Load each Pi package where its tools are used](./0069-load-each-pi-package-where-its-tools-are-used.md)
